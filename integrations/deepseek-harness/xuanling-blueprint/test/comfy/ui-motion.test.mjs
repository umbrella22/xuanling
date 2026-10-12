// Production Panel, Workspace, node/edge renderers and effects with public React/
// Flow seats. Native CSS timeline/geometry acceptance is main-owned.
import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import { en, zh } from '../../src/client/locales.ts'
const seat = { active: null }, key = Symbol.for('blueprint.comfy.motion-ui')
globalThis[key] = seat
seat.react = {
  Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), memo: fn => fn,
  useState(initial) { const f = seat.active, i = f.cursor++; if (!(i in f.states)) f.states[i] = typeof initial === 'function' ? initial() : initial; return [f.states[i], v => { f.states[i] = typeof v === 'function' ? v(f.states[i]) : v; f.stateWrites++ }] },
  useRef(initial) { const f = seat.active, i = f.refCursor++; return f.refs[i] ??= { current: initial } },
  useMemo: fn => fn(), useCallback: fn => fn,
  useEffect(fn, deps) { const f = seat.active, i = f.effectCursor++; const prev = f.effects[i]; if (!prev || !deps || deps.some((v, j) => !Object.is(v, prev.deps?.[j]))) f.pending.set(i, { fn, deps }) },
}
const dataUrl = code => `data:text/javascript,${encodeURIComponent(code)}`
const react = dataUrl(`export default globalThis[Symbol.for('blueprint.comfy.motion-ui')].react; export const createElement=globalThis[Symbol.for('blueprint.comfy.motion-ui')].react.createElement`)
const flow = dataUrl(`export const useReactFlow=()=>globalThis[Symbol.for('blueprint.comfy.motion-ui')].active.flow;
export const Position={Left:'left',Right:'right'},MarkerType={ArrowClosed:'arrowclosed'};
export const ReactFlow='flow',ReactFlowProvider='provider',Background='background',Controls='controls',MiniMap='minimap',Handle='handle',NodeResizer='resizer',BaseEdge='base-edge';
export const getSmoothStepPath=({sourceX,sourceY,targetX,targetY})=>['M '+sourceX+' '+sourceY+' C 80 20 120 40 '+targetX+' '+targetY,100,30];`)
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
class Events extends EventTarget {
  added = []; removed = []
  addEventListener(...args) { this.added.push(args); super.addEventListener(...args) }
  removeEventListener(...args) { this.removed.push(args); super.removeEventListener(...args) }
}
function environment({ visible = true, reduced = false } = {}) {
  const doc = new Events(), win = new Events(), media = new Events()
  doc.visibilityState = visible ? 'visible' : 'hidden'; doc.getElementById = () => ({})
  media.matches = reduced; win.matchMedia = query => { assert.equal(query, '(prefers-reduced-motion: reduce)'); return media }
  const originals = new Map(), timers = []
  for (const [name, value] of Object.entries({ document: doc, window: win, setInterval: (...args) => { timers.push(args); return timers.length }, clearInterval: () => {} })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  return { doc, win, media, timers, restore() { for (const [name, desc] of originals) { if (desc) Object.defineProperty(globalThis, name, desc); else delete globalThis[name] } } }
}
async function fixture(options = {}) {
  const env = environment(options)
  const d = options.definition ?? { schemaVersion: 1, id: 'flow', name: 'Flow', resources: {}, graph: { nodes: [{ id: 'a', kind: 'input', outputs: { 'raw.中文': 'string' } }, { id: 'b', kind: 'output', inputs: { 'raw.中文': 'string' } }, { id: 'c', kind: 'input' }], edges: [{ kind: 'data', from: 'a.raw.中文', to: 'b.raw.中文' }] }, presentation: { nodes: { a: { x: 50, y: 50 }, b: { x: 400, y: 50 }, c: { x: 800, y: 50 } } } }
  const doc = { blueprintId: 'flow', definitionJson: JSON.stringify(d), documentRevision: 'v1', semanticRevision: 's1', layoutRevision: 'l1' }
  const values = new Map(), calls = []
  const f = { states: [], refs: [], effects: [], pending: new Map(), cursor: 0, refCursor: 0, effectCursor: 0, stateWrites: 0, values, calls, env, locale: en,
    flow: { fitView: async () => {}, setViewport: async () => {}, getViewport: () => ({ x: 0, y: 0, zoom: 1 }), screenToFlowPosition: p => p, getNodes: () => [], zoomIn: async () => {}, zoomOut: async () => {} } }
  const host = { listDefinitions: async () => ({ definitions: [{ blueprintId: 'flow', name: 'Flow', documentRevision: 'v1', semanticRevision: 's1' }, { blueprintId: 'flow-b', name: 'Flow B', documentRevision: 'v1', semanticRevision: 's1' }] }), loadDefinition: async id => ({ ...doc, blueprintId: id, definitionJson: JSON.stringify({ ...d, id }) }) }
  const Panel = panel.createBlueprintPanel({ hostLink: host, storage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => { calls.push([k, v]); values.set(k, v) } } })
  const t = (k, params = {}) => { assert.ok(Object.hasOwn(f.locale, k), `locale key ${k}`); return f.locale[k].replace(/\{([^}]+)\}/g, (_, name) => String(params[name] ?? `{${name}}`)) }
  seat.active = f; const entry = Panel({ t }).children[0]
  f.render = () => { seat.active = f; f.cursor = f.refCursor = f.effectCursor = 0; return f.tree = entry.type({ t }) }
  f.commit = () => { for (const [i, effect] of f.pending) { f.effects[i]?.cleanup?.(); f.effects[i] = { ...effect, cleanup: effect.fn() } } f.pending.clear() }
  f.close = () => { for (const effect of f.effects) effect?.cleanup?.(); env.restore() }
  f.render(); f.workspace = f.states[0]; await f.workspace.initialize(); await f.workspace.load('flow'); f.render(); f.commit()
  f.setRun = (attempts = [{ nodeId: 'a', state: 'succeeded', attempt: 1 }, { nodeId: 'b', state: 'running', attempt: 2 }], state = 'running') => {
    f.workspace.runId = 'run-fixture'; f.workspace.model.applySnapshot({ runId: 'run-fixture', state, seq: 8, definitionRevision: 's1', attempts, logTail: [] }); f.render()
  }
  f.setRun(); return f
}
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
const publicAction = (f, id) => one(publicTree(f, id), n => n.props['data-bp-action'] === id)
const flowOf = f => one(f.render(), n => n.type === 'flow')
const rootOf = f => one(f.render(), n => n.props['data-bp-canvas'] === 'root')
const nodeOf = (f, id = 'b') => { const flow = flowOf(f), node = flow.props.nodes.find(n => n.id === id); return flow.props.nodeTypes.blueprint({ id, data: node.data, selected: false }) }
const edgeOf = (f, index = 0) => { const flow = flowOf(f), edge = flow.props.edges[index]; return flow.props.edgeTypes.blueprintEdge({ ...edge, sourceX: 0, sourceY: 10, targetX: 200, targetY: 60 }) }
const motionPaths = f => all(edgeOf(f), n => n.type === 'path' && n.props.className === 'bp-directed-light')
const facts = f => ({ document: f.workspace.editor.exportDefinition(), dirty: f.workspace.dirty, undo: f.workspace.editor.canUndo, redo: f.workspace.editor.canRedo, input: f.workspace.inputJson, run: f.workspace.model.view, storage: [...f.values] })

test('C10 actual renderer raw latest ordinal and caption share projection; unknown and idle explicit', async () => {
  const f = await fixture()
  try {
    f.setRun([{ nodeId: 'a', state: 'succeeded', attempt: 1 }, { nodeId: 'b', state: 'running', attempt: 8 }, { nodeId: 'b', state: 'failed', attempt: 2 }])
    const node = nodeOf(f)
    assert.equal(node.props['data-bp-raw-state'], 'running', 'RAW_LATEST_RENDERER_PROJECTION_MISSING')
    assert.equal(one(node, n => n.props['data-bp-node-state']).children[0], en['state.running'])
    assert.equal(node.props['data-bp-motion'], 'pulse'); assert.equal(nodeOf(f, 'c').props['data-bp-raw-state'], 'idle')
    f.setRun([{ nodeId: 'b', state: 'vendor-state', attempt: 1 }])
    assert.equal(nodeOf(f).props['data-bp-raw-state'], 'unknown'); assert.equal(nodeOf(f).props['data-bp-motion'], 'static')
    assert.equal(one(nodeOf(f), n => n.props['data-bp-node-state']).children[0], en['node.unknownState'])
    f.setRun([{ nodeId: 'b', state: 'running', attempt: 0 }]); assert.equal(nodeOf(f).props['data-bp-raw-state'], 'unknown')
  } finally { f.close() }
})
test('C10 active directed single light uses exact BaseEdge path, including visual reroutes and editor identity', async () => {
  const f = await fixture()
  try {
    for (const points of [[], [{ x: 30, y: 40 }, { x: 150, y: -20 }]]) {
      const id = f.workspace.editor.edges[0].id
      if (points.length) f.workspace.editor.importLayout({ ...f.workspace.editor.exportLayout(), edges: [{ kind: 'data', from: 'a.raw.中文', to: 'b.raw.中文', points }] })
      const tree = edgeOf(f), base = one(tree, n => n.type === 'base-edge'), light = one(tree, n => n.type === 'path' && n.props.className === 'bp-directed-light')
      assert.equal(tree.props['data-bp-motion-edge'], id); assert.equal(light.props.d, base.props.path)
      assert.equal(light.props.pathLength, 1); assert.equal(light.props.strokeDasharray, '0 2'); assert.equal(light.props.strokeLinecap, 'round')
      assert.equal(light.props.pointerEvents, 'none'); assert.equal(light.props['aria-hidden'], true); assert.equal(light.props.markerEnd, undefined)
      assert.equal(one(tree, n => n.props['data-bp-edge'] === id).props['data-bp-motion'], 'pulse')
      assert.equal(all(tree, n => n.props['data-bp-reroute']).length, points.length)
    }
  } finally { f.close() }
})
test('C11 node emphasis is separate absolute decoration; geometry/typed handles/selection remain stable', async () => {
  const f = await fixture()
  try {
    const before = flowOf(f).props.nodes.map(n => ({ id: n.id, position: n.position, style: n.style })), node = nodeOf(f)
    assert.equal(all(node, n => n.props.className === 'bp-node-emphasis').length, 1, 'ACTIVE_NODE_DECORATION_MISSING')
    const handles = all(node, n => n.type === 'handle').map(n => n.props)
    publicAction(f, 'motion-toggle').props.onClick()
    assert.equal(all(nodeOf(f), n => n.props.className === 'bp-node-emphasis').length, 0)
    assert.deepEqual(all(nodeOf(f), n => n.type === 'handle').map(n => n.props), handles)
    assert.deepEqual(flowOf(f).props.nodes.map(n => ({ id: n.id, position: n.position, style: n.style })), before)
  } finally { f.close() }
})
test('C10 real environment properties and event listeners drive stop/resume with symmetric locale-stable cleanup', async () => {
  const f = await fixture({ visible: false, reduced: true })
  try {
    f.commit()
    assert.equal(rootOf(f).props['data-bp-motion-visible'], 'false', 'VISIBILITY_PROJECTION_MISSING')
    assert.equal(rootOf(f).props['data-bp-motion-reduced'], 'true'); assert.equal(motionPaths(f).length, 0)
    const visibility = f.env.doc.added.filter(a => a[0] === 'visibilitychange'), media = f.env.media.added.filter(a => a[0] === 'change')
    assert.equal(visibility.length, 1); assert.equal(media.length, 1)
    f.env.doc.visibilityState = 'visible'; f.env.doc.dispatchEvent(new Event('visibilitychange')); f.env.media.matches = false; f.env.media.dispatchEvent(new Event('change')); f.render(); f.commit()
    assert.equal(rootOf(f).props['data-bp-motion-loops'], 'true'); assert.equal(motionPaths(f).length, 1)
    const writes = f.stateWrites, timers = f.env.timers.length
    f.locale = zh; f.render(); f.commit()
    assert.equal(f.env.doc.added.filter(a => a[0] === 'visibilitychange').length, 1); assert.equal(f.env.media.added.length, 1)
    assert.equal(f.stateWrites, writes); assert.equal(f.env.timers.length, timers)
    f.close = ((close) => () => { close(); assert.ok(f.env.doc.removed.some(a => a[0] === 'visibilitychange' && a[1] === visibility[0][1])); assert.ok(f.env.media.removed.some(a => a[0] === 'change' && a[1] === media[0][1])) })(f.close)
  } finally { f.close() }
})
for (const gate of ['off', 'hidden', 'reduced', 'stale', 'disconnected', 'terminal', 'unknown', 'unmatched']) test(`C10 actual renderer stops all continuous effects for ${gate}`, async () => {
  const f = await fixture()
  try {
    f.commit()
    if (gate === 'off') publicAction(f, 'motion-toggle').props.onClick()
    if (gate === 'hidden') { f.env.doc.visibilityState = 'hidden'; f.env.doc.dispatchEvent(new Event('visibilitychange')) }
    if (gate === 'reduced') { f.env.media.matches = true; f.env.media.dispatchEvent(new Event('change')) }
    if (gate === 'stale' || gate === 'disconnected') f.workspace.model.markDisconnected()
    if (gate === 'terminal') f.setRun(undefined, 'succeeded')
    if (gate === 'unknown') f.setRun(undefined, 'unrecognized')
    if (gate === 'unmatched') f.workspace.model.applySnapshot({ ...f.workspace.model.view, definitionRevision: 'old' })
    assert.equal(rootOf(f).props['data-bp-motion-loops'], 'false', `LOOP_GATE_MISSING:${gate}`)
    assert.equal(motionPaths(f).length, 0); assert.equal(nodeOf(f).props['data-bp-motion'], 'static')
    assert.equal(all(nodeOf(f), n => n.props.className === 'bp-node-emphasis').length, 0)
    assert.equal(nodeOf(f).props['data-bp-raw-state'], gate === 'unmatched' ? 'idle' : 'running')
  } finally { f.close() }
})
test('C11 actual hover/focus related projection survives off; old document callbacks do not anchor new document', async () => {
  const f = await fixture()
  try {
    publicAction(f, 'motion-toggle').props.onClick()
    const before = facts(f), flow = flowOf(f), oldHover = flow.props.onNodeMouseEnter
    assert.equal(typeof oldHover, 'function', 'HOVER_RELATION_HANDLER_MISSING')
    oldHover({}, { id: 'a', type: 'blueprint' })
    assert.equal(nodeOf(f, 'a').props['data-bp-relation'], 'anchor'); assert.equal(nodeOf(f).props['data-bp-relation'], 'neighbor'); assert.equal(nodeOf(f, 'c').props['data-bp-relation'], 'none')
    assert.equal(one(edgeOf(f), n => n.props['data-bp-edge']).props['data-bp-related'], 'true')
    flowOf(f).props.onNodeMouseLeave({}, { id: 'a' }); assert.equal(nodeOf(f).props['data-bp-relation'], 'none')
    const root = rootOf(f), target = { closest: () => ({ getAttribute: () => 'b' }) }
    root.props.onFocusCapture({ target }); assert.equal(nodeOf(f).props['data-bp-relation'], 'anchor')
    rootOf(f).props.onBlurCapture({ relatedTarget: null }); assert.equal(nodeOf(f).props['data-bp-relation'], 'none')
    assert.deepEqual(facts(f), before)
    await f.workspace.load('flow-b'); f.render(); oldHover({}, { id: 'a', type: 'blueprint' }); assert.equal(nodeOf(f, 'a').props['data-bp-relation'], 'none')
  } finally { f.close() }
})
test('C10/11 locale/environment changes preserve component identity, graph facts, ports and W2 Flow configuration', async () => {
  const f = await fixture()
  try {
    const before = facts(f), flow = flowOf(f), identity = { nodeTypes: flow.props.nodeTypes, edgeTypes: flow.props.edgeTypes, ids: flow.props.nodes.map(n => n.id), edges: flow.props.edges.map(e => e.id) }
    const handles = all(nodeOf(f), n => n.type === 'handle').map(n => n.props.id)
    f.locale = zh; f.env.doc.visibilityState = 'hidden'; f.env.doc.dispatchEvent(new Event('visibilitychange')); const changed = flowOf(f)
    assert.equal(changed.props.nodeTypes, identity.nodeTypes); assert.equal(changed.props.edgeTypes, identity.edgeTypes)
    assert.deepEqual(changed.props.nodes.map(n => n.id), identity.ids); assert.deepEqual(changed.props.edges.map(e => e.id), identity.edges)
    assert.deepEqual(all(nodeOf(f), n => n.type === 'handle').map(n => n.props.id), handles)
    assert.equal(one(nodeOf(f), n => n.props['data-bp-node-state']).children[0], zh['state.running']); assert.deepEqual(facts(f), before)
    for (const [prop, expected] of Object.entries({ fitView: false, reconnectRadius: 24, zoomOnScroll: true, panOnScroll: false, zoomOnPinch: true, zoomOnDoubleClick: false, selectionKeyCode: 'Shift' })) assert.equal(changed.props[prop], expected)
    assert.match(changed.props.edges[0].className, /\bnokey\b/)
  } finally { f.close() }
})
test('C11 installed CSS animates only light dash offset/opacity and absolute node opacity, with static reduced fallback', async () => {
  const { installCanvasStyles } = await import('../../src/client/styles.ts'), env = environment()
  let installed
  env.doc.getElementById = () => null; env.doc.createElement = () => ({}); env.doc.head = { appendChild: style => installed = style.textContent }
  try {
    installCanvasStyles(); assert.match(installed, /@keyframes bp-directed-light/, 'DIRECTED_LIGHT_CSS_MISSING')
    assert.match(installed, /stroke-dashoffset:\s*-1/); assert.match(installed, /\.bp-node-emphasis\s*\{[^}]*position:\s*absolute/)
    // Inspect every actual keyframe block; static rules appended later are not animation.
    const blocks = []
    postcss.parse(installed).walkAtRules(/^(?:-\w+-)?keyframes$/i, block => blocks.push(block))
    for (const name of ['bp-directed-light', 'bp-node-emphasis']) {
      const matches = blocks.filter(block => block.params.trim() === name)
      assert.equal(matches.length, 1, `MOTION_KEYFRAME_MISSING_OR_DUPLICATED:${name}`)
      assert.ok(matches[0].nodes?.length, `MOTION_KEYFRAME_EMPTY:${name}`)
    }
    const keyframes = blocks.map(block => block.toString()).join('\n')
    assert.doesNotMatch(keyframes, /\b(?:transform|width|height|top|left|margin|padding)\s*:/)
    assert.match(installed, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*animation:\s*none/)
    const source = readFileSync(new URL('../../src/client/panel.ts', import.meta.url), 'utf8')
    assert.equal((source.match(/setInterval\(/g) ?? []).length, 1, 'only existing inspect timer'); assert.doesNotMatch(source, /\.animate\(|setTimeout\(/)
  } finally { env.restore() }
})
test('C10 static execution edge keeps public identity/relation/path when light is unmounted', async () => {
  const f = await fixture()
  try {
    publicAction(f, 'motion-toggle').props.onClick()
    const tree = edgeOf(f), id = f.workspace.editor.edges[0].id
    const marked = one(tree, n => n.props['data-bp-motion-edge'] === id)
    assert.equal(marked.props['data-bp-motion'], 'static', 'STATIC_EDGE_PATH_ID_MISSING')
    assert.equal(marked.props['data-bp-related'], 'false'); assert.equal(all(marked, n => n.type === 'base-edge').length, 1)
  } finally { f.close() }
})
test('C10 actual condition branch lights only succeeded durable boolean output; human/unknown branch paths stay static', async () => {
  const definition = { schemaVersion: 1, id: 'flow', name: 'Branches', resources: {}, graph: {
    nodes: [{ id: 'a', kind: 'condition', branches: ['yes', 'no'], condition: { inputPort: 'check', trueBranch: 'yes', falseBranch: 'no' } }, { id: 'b', kind: 'output' }, { id: 'c', kind: 'output' }],
    edges: [{ kind: 'control', from: 'a@yes', to: 'b' }, { kind: 'control', from: 'a@no', to: 'c' }],
  } }
  const f = await fixture({ definition })
  try {
    const attempts = outputJson => [{ nodeId: 'a', state: 'succeeded', attempt: 1, outputJson }, { nodeId: 'b', state: 'running', attempt: 1 }, { nodeId: 'c', state: 'running', attempt: 1 }]
    for (const [output, expected] of [['{"value":true}', ['pulse', 'static']], ['{"value":false}', ['static', 'pulse']], ['{"branch":"yes"}', ['static', 'static']], ['{"value":"true"}', ['static', 'static']], ['not-json', ['static', 'static']]]) {
      f.setRun(attempts(output))
      assert.deepEqual(flowOf(f).props.edges.map(e => e.data.runtime.motion), expected)
      for (let i = 0; i < 2; i++) assert.equal(all(edgeOf(f, i), n => n.type === 'path' && n.props.className === 'bp-directed-light').length, expected[i] === 'pulse' ? 1 : 0)
    }
    f.workspace.editor.nodes[0].definition.kind = 'humanDecision'; f.workspace.editor.nodes[0].kind = 'humanDecision'
    // Semantic edit suppresses old overlay. A newly loaded imported human graph
    // with the same durable output still must not infer its chosen branch.
    assert.equal(rootOf(f).props['data-bp-motion-loops'], 'false')
  } finally { f.close() }
  for (const kind of ['humanDecision', 'vendorDecision']) {
    const imported = structuredClone(definition); imported.graph.nodes[0].kind = kind; delete imported.graph.nodes[0].condition
    const g = await fixture({ definition: imported })
    try {
      g.setRun([{ nodeId: 'a', state: 'succeeded', attempt: 1, outputJson: '{"value":true}' }, { nodeId: 'b', state: 'running', attempt: 1 }])
      assert.equal(g.workspace.runOverlayEligible, true)
      assert.deepEqual(flowOf(g).props.edges.map(e => e.data.runtime.motion), ['static', 'static'])
      assert.equal(motionPaths(g).length, 0)
    } finally { g.close() }
  }
})
test('C10 imported incomplete data declarations remain static and missing attempts stay idle; edge index is current editor order', async () => {
  const definition = { schemaVersion: 1, id: 'flow', name: 'Imported', resources: {}, graph: {
    nodes: [{ id: 'a', kind: 'vendorInput' }, { id: 'b', kind: 'output', inputs: { raw: 'string' } }, { id: 'c', kind: 'input', outputs: { raw: 'string' } }],
    edges: [{ kind: 'data', from: 'a.raw', to: 'b.raw' }, { kind: 'data', from: 'c.raw', to: 'b.raw' }],
  } }
  const f = await fixture({ definition })
  try {
    f.setRun([{ nodeId: 'a', state: 'succeeded', attempt: 1 }, { nodeId: 'b', state: 'running', attempt: 1 }, { nodeId: 'c', state: 'succeeded', attempt: 1 }])
    const flow = flowOf(f)
    assert.equal(flow.props.edges[0].data.runtime.motion, 'static'); assert.equal(flow.props.edges[1].data.runtime.motion, 'pulse')
    assert.equal(edgeOf(f, 1).props['data-bp-motion-edge'], f.workspace.editor.edges[1].id)
    assert.equal(all(nodeOf(f, 'a'), n => n.type === 'handle').length, 2, 'incomplete import gets control handles only, never invented typed data declaration')
    f.setRun([{ nodeId: 'b', state: 'running', attempt: 1 }]); assert.equal(nodeOf(f, 'a').props['data-bp-raw-state'], 'idle'); assert.equal(motionPaths(f).length, 0)
  } finally { f.close() }
})
test('C11 environment listener cleanup prevents post-unmount state updates; W3 adds no interval', async () => {
  const f = await fixture()
  f.commit(); assert.equal(f.env.timers.length, 1, 'only existing background inspect interval')
  f.close()
  const writes = f.stateWrites
  f.env.doc.visibilityState = 'hidden'; f.env.media.matches = true
  f.env.doc.dispatchEvent(new Event('visibilitychange')); f.env.media.dispatchEvent(new Event('change'))
  assert.equal(f.stateWrites, writes)
})

test('compact C06 retained native details preserve complete source facts and warnings through locale changes', async () => {
  const f = await fixture()
  try {
    f.workspace.inputJson = '{"raw":"  keep ","n":3}'
    f.workspace.editor.setSelection(['b']); f.workspace.editor.patchPresentation(['b'], { title: 'raw title' })
    f.setRun([{ nodeId: 'b', state: 'waiting_input', attempt: 2 }], 'running')
    const before = facts(f), host = structuredClone(f.workspace.document), editor = f.workspace.editor, selection = [...editor.selection], runId = f.workspace.runId
    const first = f.render(), run = one(first, n => n.props['data-bp-disclosure'] === 'run')
    assert.equal(run.type, 'details'); assert.equal(run.props.open, undefined)
    const summary = one(run, n => n.props['data-bp-disclosure-toggle'] === 'run')
    assert.equal(one(summary, n => n.props['data-bp-summary-warning'] === 'waiting_input').children[0], en['state.waiting_input'])
    assert.equal(one(run, n => n.props['data-bp-run-input']).props.value, f.workspace.inputJson)
    for (const locale of [zh, en]) {
      f.locale = locale
      const tree = f.render(), next = one(tree, n => n.props['data-bp-disclosure'] === 'run')
      assert.equal(next.type, run.type); assert.equal(next.props.key, run.props.key); assert.equal(next.props.open, undefined)
      assert.equal(one(next, n => n.props['data-bp-run-input']).props.value, before.input)
      assert.equal(one(next, n => n.props['data-bp-summary-warning'] === 'waiting_input').children[0], locale['state.waiting_input'])
      assert.deepEqual(facts(f), before); assert.deepEqual(f.workspace.document, host); assert.equal(f.workspace.editor, editor)
      assert.deepEqual([...editor.selection], selection); assert.equal(f.workspace.runId, runId)
    }
  } finally { f.close() }
})
