// Actual production Panel/Workspace/GraphEditor callbacks. Renderer seats only;
// actual browser gesture/API/download acceptance remains main-owned.
import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { en } from '../../src/client/locales.ts'
const seat = { active: null }, key = Symbol.for('blueprint.comfy.ui')
globalThis[key] = seat
seat.react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), memo: fn => fn,
  useState(initial) { const f = seat.active, i = f.cursor++; if (!(i in f.states)) f.states[i] = typeof initial === 'function' ? initial() : initial; return [f.states[i], value => f.states[i] = typeof value === 'function' ? value(f.states[i]) : value] },
  useRef(initial) { const f = seat.active, i = f.refCursor++; return f.refs[i] ??= { current: initial } },
  useMemo: fn => fn(), useCallback: fn => fn, useEffect() {},
}
const dataUrl = code => `data:text/javascript,${encodeURIComponent(code)}`
const react = dataUrl(`export default globalThis[Symbol.for('blueprint.comfy.ui')].react; export const createElement=globalThis[Symbol.for('blueprint.comfy.ui')].react.createElement`)
const flow = dataUrl(`export const useReactFlow=()=>globalThis[Symbol.for('blueprint.comfy.ui')].active.flow;
export const Position={Left:'left',Right:'right'},MarkerType={ArrowClosed:'arrowclosed'};
export const ReactFlow='flow',ReactFlowProvider='provider',Background='background',Controls='controls',MiniMap='minimap',Handle='handle',NodeResizer='resizer',BaseEdge='base-edge';
export const getSmoothStepPath=({sourceX,sourceY,targetX,targetY})=>['M '+sourceX+' '+sourceY+' L '+targetX+' '+targetY,(sourceX+targetX)/2,(sourceY+targetY)/2];`)
const client = new URL('../../src/client/', import.meta.url).href
const hooks = registerHooks({ resolve(spec, context, next) {
  if (context.parentURL === `${client}panel.ts` && spec === './inspector.ts') return { url: dataUrl('export function NodeInspector(){}'), shortCircuit: true }
  if (context.parentURL?.startsWith(client) && spec === 'react') return { url: react, shortCircuit: true }
  if (context.parentURL?.startsWith(client) && spec === '@xyflow/react') return { url: flow, shortCircuit: true }
  return next(spec, context)
} })
let panel
try { panel = await import(`${client}panel.ts`) } finally { hooks.deregister() }
test.after(() => delete globalThis[key])
const all = (tree, pred) => !tree || typeof tree !== 'object' ? [] : [...(pred(tree) ? [tree] : []), ...(tree.children ?? []).flat(Infinity).flatMap(c => all(c, pred))]
const one = (tree, pred) => { const found = all(tree, pred); assert.equal(found.length, 1); return found[0] }
// Input adaptation only: walk the actual public More/menu group callbacks.
// The overlay has its own renderer seat; Panel state and all behavior oracles stay intact.
function publicTree(f, id) {
  const current = f.render()
  if (all(current, n => n.props['data-bp-action'] === id).length) return current
  let entry = all(current, n => n.props.overlay?.kind === 'more-menu')[0]
  if (!entry) { one(current, n => n.props['data-bp-action'] === 'more-actions').props.onClick(); entry = one(f.render(), n => n.props.overlay?.kind === 'more-menu') }
  const group = ['export-blueprint', 'export-legacy', 'import-blueprint'].includes(id) ? 'files' : ['motion-toggle', 'toggle-minimap'].includes(id) ? 'view' : 'tools'
  if (f.publicMenu?.key !== entry.props.key) f.publicMenu = { key: entry.props.key, states: [], refs: [], cursor: 0, refCursor: 0 }
  const state = f.publicMenu
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), Fragment: 'fragment',
    useState(initial) { const i = state.cursor++; if (!(i in state.states)) state.states[i] = typeof initial === 'function' ? initial() : initial; return [state.states[i], v => state.states[i] = typeof v === 'function' ? v(state.states[i]) : v] },
    useRef(initial) { return state.refs[state.refCursor++] ??= { current: initial } }, useEffect() {} }
  const render = () => { state.cursor = state.refCursor = 0; return entry.type({ ...entry.props, React }) }
  one(render(), n => n.props['data-bp-menu-group'] === group).props.onClick()
  return render()
}
const action = (f, id) => one(publicTree(f, id), n => n.props['data-bp-action'] === id)
const flowOf = f => one(f.render(), n => n.type === 'flow')
async function fixture({ viewportRaw, load = true } = {}) {
  const d = { schemaVersion: 1, id: 'flow', name: 'Flow', resources: {}, graph: { nodes: [{ id: 'a', kind: 'input', outputs: { raw: 'string' } }, { id: 'b', kind: 'output', inputs: { raw: 'string' } }], edges: [{ kind: 'data', from: 'a.raw', to: 'b.raw' }] }, presentation: { nodes: { a: { x: 50, y: 50 }, b: { x: 400, y: 50 } } } }
  const doc = { blueprintId: 'flow', definitionJson: JSON.stringify(d), documentRevision: 'v1', semanticRevision: 's1', layoutRevision: 'l1' }
  const values = new Map(), calls = []
  if (viewportRaw !== undefined) values.set('xuanling-blueprint:viewport:flow', viewportRaw)
  const f = { states: [], refs: [], cursor: 0, refCursor: 0, values, calls, flow: { fitView: async options => calls.push(['fitView', options]), setViewport: async v => calls.push(['viewport', v]), getViewport: () => ({ x: 0, y: 0, zoom: 1 }), screenToFlowPosition: p => p, getNodes: () => [], zoomIn: async () => {}, zoomOut: async () => {} } }
  const host = { listDefinitions: async () => ({ definitions: [{ blueprintId: 'flow', name: 'Flow', documentRevision: 'v1', semanticRevision: 's1' }, { blueprintId: 'flow-b', name: 'Flow B', documentRevision: 'v1', semanticRevision: 's1' }] }),
    loadDefinition: async id => ({ ...structuredClone(doc), blueprintId: id, definitionJson: JSON.stringify({ ...d, id }) }) }
  const Panel = panel.createBlueprintPanel({ hostLink: host, storage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) } })
  const t = (k, params = {}) => { assert.ok(Object.hasOwn(en, k), `locale key ${k}`); return en[k].replace(/\{([^}]+)\}/g, (_, name) => String(params[name] ?? `{${name}}`)) }
  seat.active = f; const entry = Panel({ t }).children[0]
  f.render = () => { seat.active = f; f.cursor = f.refCursor = 0; return f.tree = entry.type({ t }) }
  f.emptyTree = f.render(); f.workspace = f.states[0]; await f.workspace.initialize(); if (load) await f.workspace.load('flow'); f.render()
  return f
}
test('W2 panel actually exposes frozen toolbar and gesture entrypoints', async () => {
  const f = await fixture()
  for (const id of ['mode-pan', 'mode-select', 'motion-toggle', 'shortcuts', 'export-blueprint', 'export-legacy', 'import-blueprint']) {
    assert.equal(all(publicTree(f, id), n => n.props['data-bp-action'] === id).length, 1, `W2_UI_ACTION_MISSING:${id}`)
  }
  for (const name of ['onPaneContextMenu', 'onNodeContextMenu', 'onEdgeContextMenu', 'onReconnect', 'onReconnectStart', 'onReconnectEnd', 'onMoveEnd']) assert.equal(typeof flowOf(f).props[name], 'function', name)
})
test('C02 selection mode and canvas shortcuts mutate real editor; typing/IME/busy/lock retain it', async () => {
  const f = await fixture(), editor = f.workspace.editor
  action(f, 'mode-select').props.onClick(); assert.equal(flowOf(f).props.selectionOnDrag, true)
  assert.deepEqual(flowOf(f).props.panOnDrag, [1]); assert.equal(flowOf(f).props.panActivationKeyCode, 'Space')
  const keydown = props => { let prevented = false; one(f.render(), n => n.props['data-bp-canvas'] === 'root').props.onKeyDown({ target: { closest: s => s.includes('canvas') ? {} : null }, key: 'a', ctrlKey: true, preventDefault() { prevented = true }, ...props }); return prevented }
  assert.equal(keydown({}), true); assert.equal(editor.selection.size, 2)
  const before = editor.exportDefinition(); assert.equal(keydown({ key: 'Delete', target: { tagName: 'INPUT' } }), false)
  assert.equal(keydown({ key: 'Delete', nativeEvent: { isComposing: true }, isComposing: true }), false)
  f.workspace.busy = true; keydown({ key: 'Delete' }); assert.deepEqual(editor.exportDefinition(), before); f.workspace.busy = false
  keydown({ key: 'h', ctrlKey: false }); keydown({ key: 'Delete' }); assert.deepEqual(editor.exportDefinition(), before)
})
test('C03 pane doubleclick opens search at graph coordinate and typed drop candidate adds/connects one undo', async () => {
  const f = await fixture(), editor = f.workspace.editor, before = editor.exportDefinition()
  const event = { clientX: 220, clientY: 100, target: { closest: () => null }, preventDefault() {}, stopPropagation() {} }
  one(f.render(), n => n.props['data-bp-canvas'] === 'surface').props.onDoubleClick(event)
  let overlay = all(f.render(), n => typeof n.type === 'function' && n.props.overlay?.kind === 'node-search')[0]
  assert.ok(overlay, 'production search overlay wired')
  overlay.props.onAdd('agentTask'); assert.equal(editor.nodes.length, 3); editor.undo(); assert.deepEqual(editor.exportDefinition(), before)
  flowOf(f).props.onConnectStart(event, { nodeId: 'a', handleId: 'data:raw', handleType: 'source' })
  flowOf(f).props.onConnectEnd(event, { isValid: false, toNode: null })
  overlay = all(f.render(), n => typeof n.type === 'function' && n.props.overlay?.kind === 'node-search')[0]
  assert.equal(overlay.props.overlay.origin.port, 'raw'); overlay.props.onAdd('output')
  assert.equal(editor.edges.length, 2); editor.undo(); assert.deepEqual(editor.exportDefinition(), before); assert.equal(editor.canUndo, false)
})
test('C03 actual Flow seat disables native doubleclick zoom so blank search and cancel preserve viewport/document/history', async () => {
  const f = await fixture(), editor = f.workspace.editor, before = editor.exportDefinition()
  const mountedFlow = flowOf(f)
  assert.equal(mountedFlow.props.zoomOnDoubleClick, false, 'C03_DOUBLECLICK_SEARCH_NATIVE_ZOOM_MUST_BE_DISABLED')
  assert.equal(mountedFlow.props.zoomOnScroll, true); assert.equal(mountedFlow.props.zoomOnPinch, true)
  assert.equal(mountedFlow.props.panOnScroll, false); assert.equal(mountedFlow.props.panActivationKeyCode, 'Space')
  assert.equal(all(mountedFlow, n => n.type === 'controls').length, 1, 'existing zoom controls remain mounted')
  const viewport = { x: 37, y: -20, zoom: 0.67 }
  f.flow.getViewport = () => ({ ...viewport })
  const stored = [...f.values], calls = [...f.calls]
  const surface = () => one(f.render(), n => n.props['data-bp-canvas'] === 'surface')
  const event = { clientX: 220, clientY: 100, target: { closest: () => null }, preventDefault() {}, stopPropagation() {} }
  surface().props.onDoubleClick(event)
  const search = one(f.render(), n => n.props.overlay?.kind === 'node-search')
  assert.deepEqual(search.props.overlay.position, { x: 220, y: 100 })
  search.props.onClose(); assert.equal(all(f.render(), n => n.props.overlay?.kind === 'node-search').length, 0)
  for (const excluded of ['.react-flow__node', '.react-flow__edge', '.react-flow__controls', '.react-flow__minimap']) {
    surface().props.onDoubleClick({ ...event, target: { closest: selector => selector.includes(excluded) ? {} : null } })
    assert.equal(all(f.render(), n => n.props.overlay?.kind === 'node-search').length, 0, excluded)
  }
  const flow = flowOf(f), node = flow.props.nodes.find(n => n.id === 'a')
  const renderer = flow.props.nodeTypes.blueprint({ id: node.id, data: node.data, selected: true })
  let stopped = false
  one(renderer, n => n.props.className === 'bp-node-title').props.onDoubleClick({ ...event, stopPropagation() { stopped = true } })
  assert.equal(stopped, true); assert.equal(all(f.render(), n => n.props.overlay?.kind === 'node-search').length, 0)
  one(f.tree, n => n.props.overlay?.kind === 'rename').props.onClose()
  assert.deepEqual(f.flow.getViewport(), viewport); assert.deepEqual(f.calls, calls); assert.deepEqual([...f.values], stored)
  assert.deepEqual(editor.exportDefinition(), before); assert.equal(f.workspace.dirty, false)
  assert.equal(editor.canUndo, false); assert.equal(editor.canRedo, false)
})
test('C06 collapse/pin/color/resize controls keep all typed handles mounted', async () => {
  const f = await fixture(), editor = f.workspace.editor
  editor.patchPresentation(['a'], { collapsed: true, pinned: true, color: 'blue', width: 320, height: 210 }); f.render()
  const node = flowOf(f).props.nodes.find(n => n.id === 'a')
  assert.equal(node.draggable, false); assert.equal(node.style.width, 320)
  const renderer = flowOf(f).props.nodeTypes.blueprint({ id: node.id, data: node.data, selected: true })
  assert.equal(renderer.props['data-bp-collapsed'], 'true'); assert.equal(renderer.props['data-bp-color'], 'blue')
  assert.equal(all(renderer, n => n.type === 'handle').length, 3)
  assert.equal(all(renderer, n => n.props['data-bp-resize'] === 'a').length, 1)
})
test('C08 delayed public onMoveEnd refuses old editor/ID including A to B to A; current viewport never writes draft/history', async () => {
  const f = await fixture(), oldMove = flowOf(f).props.onMoveEnd
  oldMove(null, { x: 33, y: 44, zoom: 0.75 })
  const storedA = f.values.get('xuanling-blueprint:viewport:flow')
  await f.workspace.load('flow-b'); f.render()
  const beforeB = [...f.values], editorB = f.workspace.editor
  oldMove(null, { x: 999, y: 999, zoom: 2 }); assert.deepEqual([...f.values], beforeB)
  assert.equal(editorB.canUndo, false); assert.equal(f.workspace.dirty, false)
  flowOf(f).props.onMoveEnd(null, { x: -10, y: -20, zoom: 0.5 })
  assert.ok(f.values.has('xuanling-blueprint:viewport:flow-b')); assert.equal(f.values.get('xuanling-blueprint:viewport:flow'), storedA)
  assert.ok(![...f.values.keys()].some(k => k.includes(':draft:')))
  await f.workspace.load('flow'); f.render(); const beforeA = [...f.values]
  oldMove(null, { x: 777, y: 777, zoom: 2 }); assert.deepEqual([...f.values], beforeA)
})
test('C08 delayed navigation RAF captures initiating load generation and rejects A to B to A', async () => {
  const f = await fixture(), frames = []
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')
  globalThis.requestAnimationFrame = fn => { frames.push(fn); return frames.length }
  const navigate = async id => {
    one(f.render(), n => n.props['data-bp-select'] === 'blueprint').props.onChange({ target: { value: id } })
    for (let i = 0; i < 50 && f.workspace.busy; i++) await Promise.resolve()
    assert.equal(f.workspace.busy, false); assert.equal(f.workspace.blueprintId, id); f.render()
  }
  try {
    await navigate('flow-b'); const old = frames[0]
    await navigate('flow'); await navigate('flow-b')
    const before = [...f.values]; f.calls.length = 0
    old(); assert.deepEqual(f.calls, []); assert.deepEqual([...f.values], before)
    frames.at(-1)(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'fitView')
  } finally { if (descriptor) Object.defineProperty(globalThis, 'requestAnimationFrame', descriptor); else delete globalThis.requestAnimationFrame }
})
const savedViewportPrefs = {
  version: 1, viewport: { x: -99.03664098406466, y: 76.82373943475864, zoom: 0.9475729354058113 },
  mode: 'select', minimap: false, motion: 'off', canvasLocked: false,
}
async function withNavigationFrames(f, run) {
  const frames = [], descriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')
  globalThis.requestAnimationFrame = fn => { frames.push(fn); return frames.length }
  const navigate = async id => {
    one(f.render(), n => n.props['data-bp-select'] === 'blueprint').props.onChange({ target: { value: id } })
    for (let i = 0; i < 50 && f.workspace.busy; i++) await Promise.resolve()
    assert.equal(f.workspace.busy, false); assert.equal(f.workspace.blueprintId, id); f.render()
  }
  try { await run({ frames, navigate }) }
  finally { if (descriptor) Object.defineProperty(globalThis, 'requestAnimationFrame', descriptor); else delete globalThis.requestAnimationFrame }
}
test('C08 cold empty Panel Flow seat never queues automatic initial fit', async () => {
  const f = await fixture({ load: false, viewportRaw: JSON.stringify(savedViewportPrefs) })
  const emptyFlow = one(f.emptyTree, n => n.type === 'flow')
  assert.equal(emptyFlow.props.nodes.length, 0)
  assert.equal(emptyFlow.props.fitView, false, 'C08_COLD_EMPTY_FLOW_MUST_NOT_QUEUE_AUTO_FIT')
  assert.equal(flowOf(f).props.fitView, false)
  assert.deepEqual(f.calls, [])
})
test('C08 loaded saved Panel Flow seat never queues fit over restored preferences', async () => {
  const raw = JSON.stringify(savedViewportPrefs), f = await fixture({ viewportRaw: raw })
  const flow = flowOf(f)
  assert.equal(flow.props.nodes.length, 2)
  assert.equal(flow.props.fitView, false, 'C08_SAVED_FLOW_MUST_NOT_QUEUE_AUTO_FIT')
  assert.equal(flow.props.viewport, undefined, 'viewport remains uncontrolled')
  assert.equal(flow.props.zoomOnScroll, true); assert.equal(flow.props.zoomOnPinch, true)
  assert.equal(flow.props.zoomOnDoubleClick, false); assert.equal(flow.props.panOnScroll, false)
  assert.equal(flow.props.reconnectRadius, 24)
  assert.equal(f.values.get('xuanling-blueprint:viewport:flow'), raw)
})
test('C08 cold saved prefs restore exact raw viewport via public select load and guarded RAF', async () => {
  const raw = JSON.stringify(savedViewportPrefs), f = await fixture({ load: false, viewportRaw: raw })
  f.flow.setViewport = async (viewport, options) => { f.calls.push(['viewport', viewport, options]) }
  await withNavigationFrames(f, async ({ frames, navigate }) => {
    await navigate('flow')
    const before = f.workspace.editor.exportDefinition(), hostDocument = structuredClone(f.workspace.document), stored = [...f.values]
    assert.equal(frames.length, 1); assert.deepEqual(f.calls, [])
    frames[0]()
    assert.deepEqual(f.calls, [['viewport', savedViewportPrefs.viewport, { duration: 0 }]])
    const root = one(f.render(), n => n.props['data-bp-canvas'] === 'root')
    assert.equal(root.props['data-bp-mode'], 'select'); assert.equal(root.props['data-bp-motion'], 'off')
    assert.equal(all(f.tree, n => n.type === 'minimap').length, 0)
    flowOf(f).props.onMoveEnd(null, structuredClone(savedViewportPrefs.viewport))
    assert.equal(f.values.get('xuanling-blueprint:viewport:flow'), raw)
    assert.deepEqual([...f.values], stored); assert.deepEqual(f.workspace.editor.exportDefinition(), before)
    assert.deepEqual(f.workspace.document, hostDocument); assert.equal(f.workspace.dirty, false)
    assert.equal(f.workspace.editor.canUndo, false); assert.equal(f.workspace.editor.canRedo, false)
  })
})
for (const [name, viewportRaw] of [['missing', undefined], ['corrupt', '{"version":1,"viewport":{"zoom":"invalid"}}']]) {
  test(`C08 cold ${name} prefs call explicit fit exactly once without document or storage writes`, async () => {
    const f = await fixture({ load: false, viewportRaw })
    await withNavigationFrames(f, async ({ frames, navigate }) => {
      await navigate('flow')
      const before = f.workspace.editor.exportDefinition(), stored = [...f.values], hostDocument = structuredClone(f.workspace.document)
      assert.equal(frames.length, 1); assert.deepEqual(f.calls, [])
      frames[0](); f.render(); f.render()
      assert.deepEqual(f.calls, [['fitView', { duration: 0, padding: 0.2 }]])
      const root = one(f.tree, n => n.props['data-bp-canvas'] === 'root')
      assert.equal(root.props['data-bp-mode'], 'pan'); assert.equal(root.props['data-bp-motion'], 'on')
      assert.equal(all(f.tree, n => n.type === 'minimap').length, 1)
      assert.deepEqual([...f.values], stored); assert.deepEqual(f.workspace.editor.exportDefinition(), before)
      assert.deepEqual(f.workspace.document, hostDocument); assert.equal(f.workspace.dirty, false)
      assert.equal(f.workspace.editor.canUndo, false); assert.equal(f.workspace.editor.canRedo, false)
    })
  })
}
test('C08 manual fit and fit selection remain explicit after saved viewport restoration', async () => {
  const f = await fixture({ viewportRaw: JSON.stringify(savedViewportPrefs) })
  f.workspace.editor.setSelection(['a']); f.render()
  const before = f.workspace.editor.exportDefinition(), stored = [...f.values]
  const keydown = shiftKey => one(f.render(), n => n.props['data-bp-canvas'] === 'root').props.onKeyDown({
    key: 'f', shiftKey, target: { closest: s => s.includes('canvas') ? {} : null }, preventDefault() {},
  })
  keydown(false); keydown(true)
  assert.deepEqual(f.calls, [['fitView', { duration: 0, padding: 0.2 }], ['fitView', { duration: 0, padding: 0.2, nodes: [{ id: 'a' }] }]])
  assert.deepEqual(f.workspace.editor.exportDefinition(), before); assert.deepEqual([...f.values], stored)
  assert.equal(f.workspace.dirty, false); assert.equal(f.workspace.editor.canUndo, false)
})
const canvasKey = (f, key, props = {}) => {
  all(f.render(), n => n.props.overlay?.kind === 'more-menu')[0]?.props.onClose()
  one(f.render(), n => n.props['data-bp-canvas'] === 'root').props.onKeyDown({
    key, target: { closest: s => s.includes('canvas') ? {} : null }, nativeEvent: {}, preventDefault() {}, ...props,
  })
}
test('C09 locked actual Panel disables Import entry and retains native viewport controls', async () => {
  const f = await fixture(); f.workspace.host.importDefinition = async () => { assert.fail('locked import must never reach Host') }
  const entryBeforeLock = action(f, 'import-blueprint'); assert.equal(entryBeforeLock.props.disabled, false)
  canvasKey(f, 'h')
  assert.equal(action(f, 'import-blueprint').props.disabled, true, 'C09_LOCKED_IMPORT_ENTRY_MUST_BE_DISABLED')
  entryBeforeLock.props.onClick()
  assert.equal(all(f.render(), n => n.props.overlay?.kind === 'import').length, 0, 'late entry click retains lock guard')
  const flow = flowOf(f)
  assert.deepEqual(flow.props.panOnDrag, [0, 1]); assert.equal(flow.props.zoomOnScroll, true); assert.equal(flow.props.zoomOnPinch, true)
  const before = f.workspace.editor.exportDefinition()
  one(f.render(), n => n.props['data-bp-canvas'] === 'surface').props.onWheelCapture({ deltaX: 80, deltaY: 0, deltaMode: 0, target: { closest: () => null }, preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(f.calls, [['viewport', { x: -80, y: 0, zoom: 1 }]])
  canvasKey(f, 'f'); assert.deepEqual(f.calls.at(-1), ['fitView', { duration: 0, padding: 0.2 }])
  canvasKey(f, 'v'); assert.equal(action(f, 'import-blueprint').props.disabled, false)
  assert.deepEqual(f.workspace.editor.exportDefinition(), before); assert.equal(f.workspace.dirty, false); assert.equal(f.workspace.editor.canUndo, false)
})
test('C09 locked actual Panel Ctrl and Meta Open refuse visibly and menu shares disabled reason', async () => {
  const f = await fixture(); f.workspace.host.importDefinition = async () => { assert.fail('locked import must never reach Host') }
  canvasKey(f, 'h')
  for (const primary of ['ctrlKey', 'metaKey']) {
    canvasKey(f, 'o', { [primary]: true })
    assert.equal(all(f.render(), n => n.props.overlay?.kind === 'import').length, 0, 'C09_LOCKED_OPEN_MUST_NOT_OPEN_IMPORT')
    const status = one(f.tree, n => n.props['data-bp-status'] === 'message')
    assert.equal(status.props['data-bp-status-key'], 'interaction.disabled.canvas-locked'); assert.equal(status.children[0], en['interaction.disabled.canvas-locked'])
  }
  flowOf(f).props.onPaneContextMenu({ clientX: 100, clientY: 100, preventDefault() {}, stopPropagation() {} })
  const menu = one(f.render(), n => n.props.overlay?.kind === 'context-menu')
  const open = menu.props.commands.find(c => c.command === 'open')
  assert.equal(open.enabled, false); assert.equal(open.disabledReason, 'canvas-locked')
  assert.equal(menu.props.commands.find(c => c.command === 'fit-view').enabled, true)
})
for (const reason of ['canvas-locked', 'busy']) {
  test(`C09 already-open actual Panel import projects ${reason} without removing close or current guard`, async () => {
    const f = await fixture(); let imports = 0
    f.workspace.host.importDefinition = async () => { imports++; assert.fail('guard must precede Host') }
    const priorKeyDown = one(f.render(), n => n.props['data-bp-canvas'] === 'root').props.onKeyDown
    action(f, 'import-blueprint').props.onClick()
    const initial = one(f.render(), n => n.props.overlay?.kind === 'import')
    if (reason === 'busy') f.workspace.busy = true
    else priorKeyDown({ key: 'h', target: { closest: s => s.includes('canvas') ? {} : null }, nativeEvent: {}, preventDefault() {} })
    const current = one(f.render(), n => n.props.overlay?.kind === 'import')
    assert.equal(current.props.importDisabledReason, reason, 'C09_EXISTING_IMPORT_MUST_PROJECT_CURRENT_AVAILABILITY')
    const before = f.workspace.editor.exportDefinition()
    current.props.onImportFile('empty', { arrayBuffer: async () => { assert.fail('guard precedes file read') } })
    await Promise.resolve(); assert.equal(imports, 0); assert.deepEqual(f.workspace.editor.exportDefinition(), before)
    assert.equal(typeof current.props.onClose, 'function'); current.props.onClose()
    assert.equal(all(f.render(), n => n.props.overlay?.kind === 'import').length, 0)
    assert.equal(initial.props.overlay.kind, 'import'); assert.equal(f.workspace.dirty, false)
  })
}
test('C03/C05 Escape cancels connection/reconnect and rejects late release/commit without search/history', async () => {
  const f = await fixture(), editor = f.workspace.editor, before = editor.exportDefinition()
  const event = { clientX: 200, clientY: 100, target: { closest: s => s.includes('data-bp-canvas') ? {} : null }, preventDefault() {}, stopPropagation() {} }
  flowOf(f).props.onConnectStart(event, { nodeId: 'a', handleId: 'data:raw', handleType: 'source' })
  one(f.render(), n => n.props['data-bp-canvas'] === 'root').props.onKeyDown({ ...event, key: 'Escape' })
  flowOf(f).props.onConnectEnd(event, { isValid: false, toNode: null })
  assert.equal(all(f.render(), n => n.props.overlay?.kind === 'node-search').length, 0)
  const edge = flowOf(f).props.edges[0]
  flowOf(f).props.onReconnectStart(event, edge)
  one(f.render(), n => n.props['data-bp-canvas'] === 'root').props.onKeyDown({ ...event, key: 'Escape' })
  flowOf(f).props.onReconnect(edge, { source: 'a', target: 'b', sourceHandle: 'control:control', targetHandle: 'control:control' })
  flowOf(f).props.onConnectEnd(event, { isValid: false, toNode: null }); flowOf(f).props.onReconnectEnd()
  assert.deepEqual(editor.exportDefinition(), before); assert.equal(editor.canUndo, false)
  assert.equal(all(f.render(), n => n.props.overlay?.kind === 'node-search').length, 0)
})
test('C05 actual Flow seat places reconnect center beyond enlarged port hit area and retains declared typed handles', async () => {
  const f = await fixture(), editor = f.workspace.editor
  const radius = flowOf(f).props.reconnectRadius
  assert.equal(radius, 24, 'C05_RECONNECT_CENTER_MUST_CLEAR_PORT_HIT_AREA')
  const styles = readFileSync(new URL('../../src/client/styles.ts', import.meta.url), 'utf8')
  const portWidth = Number(styles.match(/\.bp-workspace \.react-flow__handle\{width:(\d+)px/)[1])
  const hitInset = Number(styles.match(/\.bp-workspace \.react-flow__handle:before\{[^}]*inset:-(\d+)px/)[1])
  // XYFlow offsets the updater center outward by its radius, in graph units.
  assert.ok(radius > portWidth / 2 + hitInset, 'reconnect center must clear the existing port hit footprint at every zoom')
  editor.updateNode('a', { outputs: { raw: 'string', 'part.中文': 'string', number: 'number' } })
  editor.updateNode('b', { inputs: { raw: 'string', 'part.中文': 'string', wrong: 'boolean' } })
  const flow = flowOf(f)
  for (const [id, direction, names] of [['a', 'source', ['raw', 'part.中文', 'number']], ['b', 'target', ['raw', 'part.中文', 'wrong']]]) {
    const node = flow.props.nodes.find(n => n.id === id)
    const renderer = flow.props.nodeTypes.blueprint({ id, data: node.data, selected: false })
    assert.deepEqual(all(renderer, n => n.type === 'handle' && n.props.type === direction && n.props.id.startsWith('data:')).map(n => [n.props.id, n.props['data-bp-port']]), names.map(name => [`data:${name}`, `${id}:data:${name}`]))
  }
  assert.equal(flow.props.zoomOnDoubleClick, false); assert.equal(flow.props.zoomOnScroll, true); assert.equal(flow.props.zoomOnPinch, true)
  const edge = flow.props.edges[0], before = editor.exportDefinition(), history = [editor.canUndo, editor.canRedo], calls = [...f.calls]
  flow.props.onReconnectStart({ button: 0, shiftKey: false }, edge)
  const connection = { source: 'a', target: 'b', sourceHandle: 'data:part.中文', targetHandle: 'data:part.中文' }
  assert.equal(flow.props.isValidConnection(connection), true)
  for (const invalid of [{ ...connection, targetHandle: 'data:wrong' }, { ...connection, sourceHandle: 'data:missing' }, { ...connection, source: 'b', target: 'a' }]) {
    assert.equal(flow.props.isValidConnection(invalid), false)
    flow.props.onReconnect(edge, invalid)
  }
  flow.props.onReconnectEnd()
  assert.deepEqual(editor.exportDefinition(), before); assert.deepEqual([editor.canUndo, editor.canRedo], history); assert.deepEqual(f.calls, calls)
})
test('C05 actual Flow seat exempts edge wrappers from Shift selection capture while retaining ordinary selection and zoom', async () => {
  const f = await fixture(), editor = f.workspace.editor
  assert.equal(editor.connect({ nodeId: 'a', port: 'control', direction: 'out', kind: 'control', type: 'control' }, { nodeId: 'b', port: 'control', direction: 'in', kind: 'control', type: 'control' }).ok, true)
  const flow = flowOf(f)
  for (const edge of flow.props.edges) {
    const classes = edge.className.split(/\s+/)
    assert.ok(classes.includes('nokey'), 'C05_SHIFT_RECONNECT_WRAPPER_MUST_EXEMPT_PANE_CAPTURE')
    assert.ok(classes.includes(`bp-edge-${edge.data.kind}`), 'retain the existing edge style token')
    assert.equal(edge.reconnectable, true)
  }
  assert.equal(flow.props.selectionKeyCode, 'Shift'); assert.equal(flow.props.reconnectRadius, 24)
  assert.equal(flow.props.zoomOnScroll, true); assert.equal(flow.props.zoomOnPinch, true)
  assert.equal(flow.props.zoomOnDoubleClick, false); assert.equal(flow.props.panOnScroll, false)
  assert.equal(flow.props.panActivationKeyCode, 'Space')
  action(f, 'mode-select').props.onClick()
  assert.equal(flowOf(f).props.selectionOnDrag, true); assert.deepEqual(flowOf(f).props.panOnDrag, [1])
  assert.ok(!one(f.tree, n => n.props['data-bp-canvas'] === 'root').props.className.split(/\s+/).includes('nokey'))
  for (const node of flowOf(f).props.nodes) assert.ok(!(node.className ?? '').split(/\s+/).includes('nokey'), 'node Shift selection remains eligible')
})
test('C05 production Flow Shift reconnect copies a declared compatible edge retaining original identity/points with one undo', async () => {
  const f = await fixture(), editor = f.workspace.editor
  editor.updateNode('b', { inputs: { raw: 'string', 'part.中文': 'string' } })
  flowOf(f).props.edges[0].data.onPoints([{ x: 220, y: 90 }, { x: 300, y: 110 }])
  const before = editor.exportDefinition(), original = structuredClone(editor.edges[0])
  const flow = flowOf(f), edge = flow.props.edges[0]
  flow.props.onReconnectStart({ button: 0, shiftKey: true }, edge)
  const connection = { source: 'a', target: 'b', sourceHandle: 'data:raw', targetHandle: 'data:part.中文' }
  assert.equal(flow.props.isValidConnection(connection), true)
  flow.props.onReconnect(edge, connection); flow.props.onReconnectEnd()
  assert.equal(editor.edges.length, 2)
  assert.deepEqual(editor.edges.find(e => e.id === original.id), original)
  const copied = editor.edges.find(e => e.id !== original.id)
  assert.deepEqual([copied.kind, copied.from, copied.to], ['data', 'a.raw', 'b.part.中文'])
  editor.undo(); assert.deepEqual(editor.exportDefinition(), before)
  assert.deepEqual(editor.edges[0], original); assert.equal(editor.canRedo, true)
  editor.redo(); assert.equal(editor.edges.length, 2); assert.deepEqual(editor.edges.find(e => e.id === original.id), original)
})
test('C05 production Flow invalid Shift copy preserves document, original edge, selection and redo atomically', async () => {
  const f = await fixture(), editor = f.workspace.editor
  editor.updateNode('b', { inputs: { raw: 'string', wrong: 'boolean' } })
  flowOf(f).props.edges[0].data.onPoints([{ x: 220, y: 90 }])
  editor.patchPresentation(['a'], { title: 'Temporary' }); editor.undo(); editor.setSelection(['a'])
  const before = editor.exportDefinition(), original = structuredClone(editor.edges[0]), selection = [...editor.selection]
  const history = [editor.canUndo, editor.canRedo], dirty = f.workspace.dirty, stored = [...f.values], calls = [...f.calls]
  assert.equal(editor.canRedo, true)
  const flow = flowOf(f), edge = flow.props.edges[0]
  flow.props.onReconnectStart({ button: 0, shiftKey: true }, edge)
  for (const connection of [
    { source: 'a', target: 'b', sourceHandle: 'data:raw', targetHandle: 'data:wrong' },
    { source: 'a', target: 'b', sourceHandle: 'data:missing', targetHandle: 'data:raw' },
    { source: 'a', target: 'b', sourceHandle: 'data:raw', targetHandle: 'data:raw' },
  ]) {
    assert.equal(flow.props.isValidConnection(connection), false)
    flow.props.onReconnect(edge, connection)
    assert.deepEqual(editor.exportDefinition(), before); assert.deepEqual(editor.edges[0], original)
    assert.deepEqual([...editor.selection], selection); assert.deepEqual([editor.canUndo, editor.canRedo], history)
    assert.equal(f.workspace.dirty, dirty); assert.deepEqual([...f.values], stored); assert.deepEqual(f.calls, calls)
  }
  flow.props.onReconnectEnd()
  editor.redo(); assert.equal(editor.nodes.find(n => n.id === 'a').presentation.title, 'Temporary', 'invalid copy retains the actual redo entry')
})
test('C06 group menu rename is available independently of member selection count', async () => {
  const f = await fixture(), editor = f.workspace.editor
  editor.setSelection(['a', 'b']); editor.groupSelection('Team')
  const frame = flowOf(f).props.nodes.find(n => n.type === 'presentationGroup')
  const event = { clientX: 220, clientY: 100, target: { closest: () => null }, preventDefault() {}, stopPropagation() {} }
  frame.data.onMenu(event)
  const menu = all(f.render(), n => n.props.overlay?.kind === 'context-menu')[0]
  const rename = menu.props.commands.find(c => c.command === 'rename')
  assert.equal(rename.enabled, true)
  menu.props.onCommand('rename')
  const dialog = all(f.render(), n => n.props.overlay?.kind === 'rename')[0]
  assert.equal(dialog.props.overlay.group, true); dialog.props.onRename('Renamed raw title')
  assert.equal(editor.groups[0].label, 'Renamed raw title'); assert.equal(editor.nodes.length, 2)
})
test('C05 actual route renderer pointer cancel/outside restore route without history and scoped keys delete only the point', async () => {
  const f = await fixture(), editor = f.workspace.editor
  editor.setSelection(['a'])
  let edge = flowOf(f).props.edges[0]
  edge.data.onPoints([{ x: 250, y: 80 }]); f.render()
  one(f.tree, n => n.props['data-bp-canvas'] === 'root').props.ref.current = {
    getBoundingClientRect: () => ({ left: 0, right: 600, top: 0, bottom: 400, width: 600, height: 400 }), querySelector: () => null,
  }
  const route = () => {
    edge = flowOf(f).props.edges[0]
    return one(panel.BlueprintEdge({ ...edge, sourceX: 50, sourceY: 50, targetX: 400, targetY: 50 }), n => n.props['data-bp-reroute'])
  }
  const target = { setPointerCapture() {}, releasePointerCapture() {}, closest: s => s.includes('data-bp-reroute') ? {} : null }
  const event = (x, y) => ({ button: 0, pointerId: 1, clientX: x, clientY: y, target, currentTarget: target, preventDefault() {}, stopPropagation() {}, nativeEvent: {} })
  const before = editor.exportDefinition()
  let circle = route(); circle.props.onPointerDown(event(250, 80)); circle.props.onPointerMove(event(310, 130)); circle.props.onPointerCancel()
  assert.deepEqual(editor.exportDefinition(), before)
  circle = route(); circle.props.onPointerDown(event(250, 80)); circle.props.onPointerMove(event(700, 500)); circle.props.onPointerUp(event(700, 500))
  assert.deepEqual(editor.exportDefinition(), before)
  // Root capture must yield to the actual circle handler even with a selected node.
  let prevented = false
  const keyEvent = { ...event(250, 80), key: 'Delete', preventDefault() { prevented = true } }
  one(f.render(), n => n.props['data-bp-canvas'] === 'root').props.onKeyDownCapture(keyEvent)
  assert.equal(prevented, false); assert.deepEqual(editor.exportDefinition(), before)
  circle = route(); circle.props.onKeyDown(keyEvent)
  assert.equal(prevented, true); assert.equal(editor.nodes.length, 2); assert.deepEqual(editor.edges[0].points, [])
  editor.undo(); assert.deepEqual(editor.exportDefinition(), before)
  // Cancel/outside did not contribute their own entries; only initial add remains.
  editor.undo(); assert.equal(editor.edges[0].points, undefined); assert.equal(editor.canUndo, false)
})
test('C06 group pointer drag rejects mixed pinned members atomically under frozen W1 contract', async () => {
  const f = await fixture(), editor = f.workspace.editor
  editor.setSelection(['a', 'b']); editor.groupSelection('Team'); editor.patchPresentation(['a'], { pinned: true })
  const frame = flowOf(f).props.nodes.find(n => n.type === 'presentationGroup'), before = editor.exportDefinition()
  let capture = 0
  const event = { button: 0, altKey: false, clientX: 100, clientY: 100, pointerId: 1,
    target: { closest: () => null }, currentTarget: { setPointerCapture() { capture++ }, releasePointerCapture() {} }, preventDefault() {}, stopPropagation() {} }
  frame.data.onPointerDown(event); frame.data.onPointerMove({ ...event, clientX: 200, clientY: 200 }); frame.data.onPointerUp(event)
  assert.equal(capture, 0); assert.deepEqual(editor.exportDefinition(), before)
})
test('C04 actual Panel clipboard uses navigator.clipboard and selection/document binding, with one cut undo', async () => {
  const f = await fixture(), editor = f.workspace.editor, descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let release; const writes = []
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: {
    writeText: text => { writes.push(text); return new Promise(resolve => release = resolve) }, readText: async () => writes.at(-1),
  } } })
  const keydown = key => one(f.render(), n => n.props['data-bp-canvas'] === 'root').props.onKeyDown({ key, ctrlKey: true, target: { closest: s => s.includes('data-bp-canvas') ? {} : null }, preventDefault() {}, stopPropagation() {} })
  try {
    editor.setSelection(['a']); const before = editor.exportDefinition()
    keydown('x'); assert.equal(writes.length, 1); assert.deepEqual(editor.exportDefinition(), before)
    release(); for (let i = 0; i < 10; i++) await Promise.resolve()
    assert.equal(editor.nodes.length, 1); editor.undo(); assert.deepEqual(editor.exportDefinition(), before); assert.equal(editor.canUndo, false)
    editor.setSelection(['a']); keydown('x'); await f.workspace.load('flow-b'); f.render()
    const destination = f.workspace.editor.exportDefinition()
    release(); for (let i = 0; i < 10; i++) await Promise.resolve()
    assert.deepEqual(f.workspace.editor.exportDefinition(), destination); assert.equal(f.workspace.editor.canUndo, false)
    const fragment = JSON.parse(writes[0]); assert.deepEqual(fragment.nodes.map(n => n.id), ['a']); assert.equal(fragment.sourceBlueprintId, 'flow')
  } finally { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator }
})
test('C06 actual Panel node drag previews/commits one undo and Escape has no late drag mutation', async () => {
  const f = await fixture(), editor = f.workspace.editor, before = editor.exportDefinition()
  editor.setSelection(['a']); let flow = flowOf(f), node = flow.props.nodes.find(n => n.id === 'a')
  const event = { clientX: 200, clientY: 100, altKey: false, target: { closest: s => s.includes('data-bp-canvas') ? {} : null }, preventDefault() {}, stopPropagation() {} }
  flow.props.onNodeDragStart(event, node)
  flowOf(f).props.onNodesChange([{ type: 'position', id: 'a', position: { x: 150, y: 130 }, dragging: true }])
  assert.deepEqual(editor.exportDefinition(), before); assert.deepEqual(flowOf(f).props.nodes.find(n => n.id === 'a').position, { x: 150, y: 130 })
  flowOf(f).props.onNodeDragStop(event); assert.equal(editor.nodes[0].x, 150); editor.undo(); assert.deepEqual(editor.exportDefinition(), before); assert.equal(editor.canUndo, false)
  editor.setSelection(['a']); flow = flowOf(f); node = flow.props.nodes.find(n => n.id === 'a'); flow.props.onNodeDragStart(event, node)
  flow.props.onNodesChange([{ type: 'position', id: 'a', position: { x: 150, y: 130 }, dragging: true }])
  one(f.render(), n => n.props['data-bp-canvas'] === 'root').props.onKeyDown({ ...event, key: 'Escape' })
  flow.props.onNodesChange([{ type: 'position', id: 'a', position: { x: 190, y: 200 }, dragging: true }]); flow.props.onNodeDragStop(event)
  assert.deepEqual(editor.exportDefinition(), before); assert.equal(editor.canUndo, false)
})
test('C02 plain wheel retains XYFlow zoom; horizontal wheel explicitly pans with unchanged zoom and no canonical edits', async () => {
  const f = await fixture(), before = f.workspace.editor.exportDefinition()
  const surface = () => one(f.render(), n => n.props['data-bp-canvas'] === 'surface')
  assert.equal(flowOf(f).props.panOnScroll, false, 'plain vertical wheel must reach XYFlow zoom handler rather than pan override')
  assert.equal(flowOf(f).props.zoomOnScroll, true); assert.equal(flowOf(f).props.zoomOnPinch, true)
  assert.equal(typeof surface().props.onWheelCapture, 'function')
  const current = { x: 30, y: 60, zoom: 0.42 }
  f.flow.getViewport = () => ({ ...current }); f.flow.setViewport = async next => { Object.assign(current, next); f.calls.push(['viewport', next]) }
  const wheel = (deltaX, deltaY, overrides = {}) => {
    let prevented = false, stopped = false
    surface().props.onWheelCapture({ deltaX, deltaY, deltaMode: 0, ctrlKey: false, metaKey: false, target: { closest: () => null }, preventDefault() { prevented = true }, stopPropagation() { stopped = true }, ...overrides })
    return { prevented, stopped }
  }
  assert.deepEqual(wheel(0, 120), { prevented: false, stopped: false }); assert.deepEqual(current, { x: 30, y: 60, zoom: 0.42 })
  assert.deepEqual(wheel(120, 0), { prevented: true, stopped: true }); assert.deepEqual(current, { x: -90, y: 60, zoom: 0.42 })
  assert.deepEqual(wheel(120, 0, { ctrlKey: true }), { prevented: false, stopped: false }, 'ctrl/pinch remain library zoom')
  assert.deepEqual(wheel(120, 0, { target: { tagName: 'TEXTAREA' } }), { prevented: false, stopped: false })
  assert.deepEqual(f.workspace.editor.exportDefinition(), before); assert.equal(f.workspace.dirty, false); assert.equal(f.workspace.editor.canUndo, false)
})
test('C06 actual NodeResizer callback reads D3 sourceEvent and cancels outside rather than adding resize history', async () => {
  const f = await fixture(), editor = f.workspace.editor, before = editor.exportDefinition()
  one(f.render(), n => n.props['data-bp-canvas'] === 'root').props.ref.current = {
    getBoundingClientRect: () => ({ left: 0, right: 600, top: 0, bottom: 400, width: 600, height: 400 }), querySelector: () => null,
  }
  const renderer = () => {
    const flow = flowOf(f), node = flow.props.nodes.find(n => n.id === 'a')
    return one(flow.props.nodeTypes.blueprint({ id: node.id, data: node.data, selected: true }), n => n.type === 'resizer')
  }
  let resizer = renderer(); resizer.props.onResizeStart(); resizer.props.onResize({}, { x: 50, y: 50, width: 340, height: 260 })
  resizer.props.onResizeEnd({ sourceEvent: { clientX: 700, clientY: 500 } }); assert.deepEqual(editor.exportDefinition(), before); assert.equal(editor.canUndo, false)
  resizer = renderer(); resizer.props.onResizeStart(); resizer.props.onResize({}, { x: 50, y: 50, width: 340, height: 260 })
  resizer.props.onResizeEnd({ sourceEvent: { clientX: 400, clientY: 200 } }); assert.equal(editor.nodes[0].presentation.width, 340)
  editor.undo(); assert.deepEqual(editor.exportDefinition(), before); assert.equal(editor.canUndo, false)
})

test('compact C01 actual toolbar exposes accessible SVG controls and keeps low-frequency actions out of the header', async () => {
  const f = await fixture(), header = one(f.render(), n => n.type === 'header' && n.props.className === 'bp-toolbar')
  for (const id of ['undo', 'redo', 'save-layout', 'mode-pan', 'mode-select', 'start-run', 'more-actions']) {
    const control = one(header, n => n.props['data-bp-action'] === id)
    assert.ok(control.props['aria-label'], `C01_ACCESSIBLE_NAME:${id}`)
    assert.equal(all(control, n => n.type === 'svg' && n.props['aria-hidden'] === true).length, 1, `C01_SVG_CONTROL:${id}`)
  }
  for (const id of ['check-run', 'export-blueprint', 'export-legacy', 'import-blueprint', 'motion-toggle', 'shortcuts', 'refresh-library']) assert.equal(all(header, n => n.props['data-bp-action'] === id).length, 0, `C03_MOVED_TO_MORE:${id}`)
})
test('host controls C01 actual Panel has no plugin pane toggles and keeps both panes and top selector without resetting editor/input/viewport', async () => {
  const f = await fixture(), editor = f.workspace.editor
  f.workspace.inputJson = '{"raw":"retain"}'
  const stored = [...f.values], before = editor.exportDefinition()
  const tree = f.render(), selector = one(tree, n => n.props['data-bp-select'] === 'blueprint')
  for (const id of ['toggle-library', 'toggle-inspector']) assert.equal(all(tree, n => n.props['data-bp-action'] === id).length, 0, `HOST_CONTROLS_PLUGIN_TOGGLE_MUST_BE_REMOVED:${id}`)
  for (const className of ['bp-library', 'bp-inspector']) assert.equal(one(tree, n => n.props.className === className).type, 'aside', `HOST_CONTROLS_PANE_MUST_STAY_MOUNTED:${className}`)
  assert.equal(all(one(tree, n => n.type === 'header'), n => n === selector).length, 1, 'C02_SELECTOR_IN_TOP_CHROME')
  assert.equal(f.workspace.editor, editor); assert.equal(f.workspace.inputJson, '{"raw":"retain"}')
  assert.deepEqual(editor.exportDefinition(), before); assert.deepEqual([...f.values], stored)
})
test('host controls C01 both panes stay mounted in empty, busy, locked and mode-change Panel states', async () => {
  const f = await fixture({ load: false })
  const panes = () => {
    const tree = f.render()
    for (const className of ['bp-library', 'bp-inspector']) assert.equal(one(tree, n => n.props.className === className).type, 'aside')
    for (const id of ['toggle-library', 'toggle-inspector']) assert.equal(all(tree, n => n.props['data-bp-action'] === id).length, 0, `HOST_CONTROLS_PLUGIN_TOGGLE_MUST_BE_REMOVED:${id}`)
  }
  panes(); await f.workspace.load('flow'); panes()
  const editor = f.workspace.editor, stored = [...f.values], before = editor.exportDefinition()
  f.workspace.busy = true; panes(); f.workspace.busy = false
  canvasKey(f, 'h'); panes(); canvasKey(f, 'h'); panes()
  action(f, 'mode-select').props.onClick(); panes(); action(f, 'mode-pan').props.onClick(); panes()
  assert.equal(f.workspace.editor, editor); assert.deepEqual(editor.exportDefinition(), before)
  assert.equal(editor.canUndo, false); assert.equal(f.workspace.dirty, false)
  // Mode/lock are existing viewport preferences; never add pane visibility preferences.
  assert.deepEqual([...f.values.keys()], [...new Set([...stored.map(([key]) => key), 'xuanling-blueprint:viewport:flow'])])
  const preferences = JSON.parse(f.values.get('xuanling-blueprint:viewport:flow'))
  assert.equal(preferences.left, undefined); assert.equal(preferences.right, undefined)
})
test('host controls C02 actual toolbar groups history, mode and run/tools while keeping native picker', async () => {
  const f = await fixture(), header = one(f.render(), n => n.props.className === 'bp-toolbar')
  for (const [group, actions] of [['history', ['undo', 'redo', 'save-layout']], ['mode', ['mode-pan', 'mode-select']], ['run-tools', ['start-run', 'cancel-run', 'more-actions']]]) {
    const section = one(header, n => n.props['data-bp-toolbar-group'] === group)
    assert.equal(section.props.role, 'group'); assert.ok(section.props['aria-label'])
    assert.deepEqual(all(section, n => n.type === 'button').map(n => n.props['data-bp-action']), actions)
  }
  const picker = one(header, n => n.props['data-bp-select'] === 'blueprint')
  assert.equal(picker.type, 'select'); assert.equal(picker.props.role, undefined)
  assert.equal(typeof picker.props.onChange, 'function'); assert.equal(picker.props.value, 'flow')
  assert.deepEqual(all(picker, n => n.type === 'option').map(n => n.props.value), ['', 'flow', 'flow-b'])
})
test('compact C06 actual disclosures keep form children mounted and expose state summaries and cancel outside the fold', async () => {
  const f = await fixture(), editor = f.workspace.editor
  f.workspace.inputJson = '{"retain":true}'; editor.setSelection(['a']); editor.patchPresentation(['a'], { title: 'draft' })
  f.workspace.runId = 'run-retain'
  const before = editor.exportDefinition(), stored = [...f.values], doc = structuredClone(f.workspace.document), history = [editor.canUndo, editor.canRedo]
  const tree = f.render()
  for (const id of ['preflight', 'run']) {
    const disclosure = one(tree, n => n.props['data-bp-disclosure'] === id)
    assert.equal(disclosure.type, 'details', `C06_NATIVE_DETAILS:${id}`)
    assert.equal(one(disclosure, n => n.props['data-bp-disclosure-toggle'] === id).type, 'summary')
    assert.notEqual(disclosure.props.open, true)
  }
  assert.equal(one(tree, n => n.props['data-bp-run-input']).props.value, '{"retain":true}')
  assert.equal(all(one(tree, n => n.props['data-bp-disclosure'] === 'run'), n => n.props['data-bp-action'] === 'cancel-run').length, 0, 'C06_CANCEL_OUTSIDE_FOLD')
  assert.equal(all(tree, n => n.props['data-bp-action'] === 'cancel-run').length, 1)
  assert.equal(f.workspace.editor, editor); assert.deepEqual(editor.exportDefinition(), before); assert.deepEqual([...editor.selection], ['a']); assert.deepEqual(f.workspace.document, doc); assert.deepEqual([...f.values], stored); assert.deepEqual([editor.canUndo, editor.canRedo], history)
})

test('compact C03 public More button anchors its menu at the actual toolbar bounds', async () => {
  const f = await fixture()
  one(f.render(), n => n.props['data-bp-canvas'] === 'root').props.ref.current = { getBoundingClientRect: () => ({ left: 100, top: 80, width: 900, height: 600 }) }
  action(f, 'more-actions').props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 890, bottom: 126 }) } })
  const overlay = one(f.render(), n => n.props.overlay?.kind === 'more-menu')
  assert.deepEqual(overlay.props.overlay.screen, { x: 790, y: 52 }, 'C03_MORE_ANCHOR_RELATIVE_TO_WORKSPACE')
})

test('compact C04 multi-selection labels follow the actual all-selected pin/collapse toggle', async () => {
  const f = await fixture(), editor = f.workspace.editor
  const event = { clientX: 100, clientY: 100, preventDefault() {}, stopPropagation() {} }
  editor.setSelection(['a', 'b']); editor.patchPresentation(['a'], { pinned: true, collapsed: true })
  const menu = () => { flowOf(f).props.onNodeContextMenu(event, { id: 'a', type: 'blueprint' }); return one(f.render(), n => n.props.overlay?.kind === 'context-menu') }
  let overlay = menu(); assert.deepEqual(overlay.props.presentationState, { allPinned: false, allCollapsed: false })
  overlay.props.onCommand('toggle-pin'); assert.ok(editor.nodes.every(n => n.presentation?.pinned))
  overlay = menu(); assert.equal(overlay.props.presentationState.allPinned, true)
  overlay.props.onCommand('toggle-pin'); assert.ok(editor.nodes.every(n => !n.presentation?.pinned))
  overlay = menu(); overlay.props.onCommand('toggle-collapse'); assert.ok(editor.nodes.every(n => n.presentation?.collapsed))
  overlay = menu(); assert.equal(overlay.props.presentationState.allCollapsed, true)
  overlay.props.onCommand('toggle-collapse'); assert.ok(editor.nodes.every(n => !n.presentation?.collapsed))
})
test('compact C03 old More callbacks cannot mutate a destination after A to B to A or while busy', async () => {
  const f = await fixture(); action(f, 'more-actions').props.onClick()
  const stale = one(f.render(), n => n.props.overlay?.kind === 'more-menu').props.moreActions.find(item => item.action === 'motion-toggle')
  f.workspace.busy = true
  const refresh = one(f.render(), n => n.props.overlay?.kind === 'more-menu').props.moreActions.find(item => item.action === 'refresh-library')
  assert.equal(refresh.enabled, false); refresh.onSelect(); assert.equal(f.workspace.busy, true)
  f.workspace.busy = false; await f.workspace.load('flow-b'); f.render(); await f.workspace.load('flow'); f.render()
  const before = [...f.values], graph = f.workspace.editor.exportDefinition()
  stale.onSelect(); assert.deepEqual([...f.values], before); assert.deepEqual(f.workspace.editor.exportDefinition(), graph)
})
test('compact C05 palette retains catalogue names/search and exposes descriptions through actual focus', async () => {
  const f = await fixture(), graph = f.workspace.editor.exportDefinition()
  const entry = one(f.render(), n => n.props['data-bp-action'] === 'add-input')
  assert.equal(all(entry, n => n.type === 'strong')[0].children[0], en['node.input.title'])
  assert.equal(all(entry, n => n.type === 'small').length, 0)
  const wrapper = one(f.tree, n => n.props.className === 'bp-palette-anchor' && all(n, child => child === entry).length)
  wrapper.props.onFocus({ currentTarget: {} })
  const tooltip = one(f.render(), n => n.props.content?.action === 'add-input')
  assert.ok(en[tooltip.props.content.labelKey]); assert.deepEqual(f.workspace.editor.exportDefinition(), graph)
})

for (const warningCount of [2, 0]) {
  test(`compact C06 r2 actual Panel closed preflight summary exposes ${warningCount} non-blocking warnings from a ready report`, async () => {
    const f = await fixture(), calls = []
    const checks = [{ status: 'pass', code: 'fixture-ready', nodeId: 'a' }, { status: 'info', code: 'fixture-info' },
      ...Array.from({ length: warningCount }, (_, i) => ({ status: 'warning', code: `fixture-private-warning-${i}`, resourceId: `fixture-private-resource-${i}` }))]
    f.workspace.host.saveDefinition = async (id, json, expected) => {
      calls.push(['save', id, expected]); return { blueprintId: id, definitionJson: json, documentRevision: 'v2', semanticRevision: 's1', layoutRevision: 'l1' }
    }
    f.workspace.host.preflightRun = async (id, revision) => {
      calls.push(['preflight', id, revision]); return { blueprintId: id, documentRevision: revision, semanticRevision: 's1', canStart: true, checks }
    }
    const report = await f.workspace.checkRun()
    assert.equal(report.canStart, true, 'ready is the existing canStart=true report, with workspace status=current')
    assert.equal(f.workspace.preflight.status, 'current'); assert.deepEqual(calls, [['save', 'flow', 'v1'], ['preflight', 'flow', 'v2']])
    const editor = f.workspace.editor, before = editor.exportDefinition(), document = structuredClone(f.workspace.document), stored = [...f.values], input = f.workspace.inputJson
    const details = one(f.render(), n => n.props['data-bp-disclosure'] === 'preflight')
    assert.equal(details.type, 'details'); assert.notEqual(details.props.open, true)
    const summary = one(details, n => n.props['data-bp-disclosure-toggle'] === 'preflight')
    assert.equal(one(summary, n => n.props['data-bp-summary-state'] === 'current').children[0], en['preflight.current'])
    const warnings = all(summary, n => n.props['data-bp-summary-warning'] === 'warning')
    assert.equal(warnings.length, warningCount ? 1 : 0, 'C06_PREFLIGHT_WARNING_VISIBLE_WHEN_CLOSED')
    if (warningCount) {
      assert.equal(warnings[0].props['data-bp-preflight-warning-count'], warningCount)
      assert.equal(warnings[0].children[0], `${en['preflight.warning']} · ${warningCount}`)
    }
    assert.doesNotMatch(JSON.stringify(summary), /fixture-private-warning|fixture-private-resource/, 'summary exposes typed count only')
    assert.equal(all(details, n => n.props['data-bp-check-status'] === 'warning').length, warningCount, 'full checks remain mounted inside details')
    assert.equal(f.workspace.editor, editor); assert.deepEqual(editor.exportDefinition(), before); assert.deepEqual(f.workspace.document, document)
    assert.deepEqual([...f.values], stored); assert.equal(f.workspace.inputJson, input); assert.deepEqual(calls, [['save', 'flow', 'v1'], ['preflight', 'flow', 'v2']])
  })
}
