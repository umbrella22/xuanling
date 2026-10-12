// Real Panel closure + Workspace/GraphEditor, controlled renderer seats.
// Not a mounted browser/Inspector-buffer acceptance test; main owns that gate.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { canvasDefinitions } from '../../../../../test/blueprint/capabilities/canvas-fixtures.mjs'
import { zh, en } from '../../src/client/locales.ts'
import { BlueprintWorkspace } from '../../src/client/workspace.ts'
import { adoptUserNodes } from '@xyflow/system'

const key = Symbol.for('blueprint.test.presentation'), seat = { active: null }
globalThis[key] = seat
seat.react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  memo: fn => fn,
  useState(initial) { const f = seat.active, i = f.cursor++; if (!(i in f.states)) f.states[i] = typeof initial === 'function' ? initial() : initial; return [f.states[i], update => { f.states[i] = typeof update === 'function' ? update(f.states[i]) : update }] },
  useRef(initial) { const f = seat.active, i = f.refCursor++; return f.refs[i] ??= { current: initial } },
  useMemo(factory, deps) { const f = seat.active, i = f.memoCursor++, last = f.memos[i]; if (!last || deps.some((v, j) => !Object.is(v, last.deps[j]))) f.memos[i] = { deps, value: factory() }; return f.memos[i].value },
  useCallback: fn => fn, useEffect() {},
}
const url = code => `data:text/javascript,${encodeURIComponent(code)}`
const react = url(`export default globalThis[Symbol.for('blueprint.test.presentation')].react; export const createElement=globalThis[Symbol.for('blueprint.test.presentation')].react.createElement;`)
const flow = url(`export const useReactFlow=()=>globalThis[Symbol.for('blueprint.test.presentation')].active.flow;
export const Position={Left:'left',Right:'right'},MarkerType={ArrowClosed:'arrowclosed'};
export const ReactFlow='flow',ReactFlowProvider='provider',Background='background',Controls='controls',MiniMap='minimap',Handle='handle',NodeResizer='resizer',BaseEdge='base-edge'; export const getSmoothStepPath=()=>['M 0 0 L 1 1',0,0];`)
// Inspector is a frozen opaque boundary here, not a fake editor implementation.
const inspector = url('export function NodeInspector(){}')
const client = new URL('../../src/client/', import.meta.url).href
const hooks = registerHooks({ resolve(spec, context, next) {
  if (context.parentURL?.startsWith(client) && spec === 'react') return { url: react, shortCircuit: true }
  if (context.parentURL === `${client}panel.ts` && spec === '@xyflow/react') return { url: flow, shortCircuit: true }
  if (context.parentURL === `${client}panel.ts` && spec === './inspector.ts') return { url: inspector, shortCircuit: true }
  return next(spec, context)
} })
let createBlueprintPanel
try { ({ createBlueprintPanel } = await import(`${client}panel.ts`)) } finally { hooks.deregister() }
test.after(() => { delete globalThis[key] })
const all = (tree, predicate) => !tree || typeof tree !== 'object' ? [] : [...(predicate(tree) ? [tree] : []), ...(tree.children ?? []).flat(Infinity).flatMap(child => all(child, predicate))]
const one = (tree, predicate) => { const found = all(tree, predicate); assert.equal(found.length, 1); return found[0] }
// Input adaptation only: actual context/More callbacks and their own overlay renderer seat.
function publicTree(f, id) {
  const current = f.render()
  if (all(current, n => n.props['data-bp-action'] === id).length) return current
  const context = ['group-selection', 'delete-selection'].includes(id)
  let entry = all(current, n => n.props.overlay?.kind === (context ? 'context-menu' : 'more-menu'))[0]
  if (!entry) {
    if (context) flowOf(f).props.onPaneContextMenu({ clientX: 100, clientY: 100, preventDefault() {}, stopPropagation() {} })
    else one(current, n => n.props['data-bp-action'] === 'more-actions').props.onClick()
    entry = one(f.render(), n => n.props.overlay?.kind === (context ? 'context-menu' : 'more-menu'))
  }
  if (f.publicMenu?.key !== entry.props.key) f.publicMenu = { key: entry.props.key, states: [], refs: [], cursor: 0, refCursor: 0 }
  const state = f.publicMenu
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), Fragment: 'fragment',
    useState(initial) { const i = state.cursor++; if (!(i in state.states)) state.states[i] = typeof initial === 'function' ? initial() : initial; return [state.states[i], v => state.states[i] = typeof v === 'function' ? v(state.states[i]) : v] },
    useRef(initial) { return state.refs[state.refCursor++] ??= { current: initial } }, useEffect() {} }
  const render = () => { state.cursor = state.refCursor = 0; return entry.type({ ...entry.props, React }) }
  if (!context) {
    const group = ['export-blueprint', 'export-legacy', 'import-blueprint'].includes(id) ? 'files' : ['motion-toggle', 'toggle-minimap'].includes(id) ? 'view' : 'tools'
    one(render(), n => n.props['data-bp-menu-group'] === group).props.onClick()
  }
  return render()
}
const action = (f, id) => one(publicTree(f, id), n => n.props['data-bp-action'] === id)
const flowOf = f => one(f.render(), n => n.type === 'flow')
async function fixture() {
  const definition = structuredClone(canvasDefinitions()[0]), calls = [], values = new Map()
  const doc = { blueprintId: definition.id, definitionJson: JSON.stringify(definition), documentRevision: 'doc-1', semanticRevision: 'semantic-1', layoutRevision: 'layout-1' }
  const snapshot = { runId: 'durable-run', state: 'succeeded', seq: 7, definitionRevision: 'semantic-1', attempts: [{ nodeId: definition.graph.nodes[0].id, attempt: 1, state: 'succeeded', outputJson: '{"原样":"payload"}' }], logTail: [] }
  const host = {
    async loadDefinition(id) { calls.push(['load', id]); return structuredClone(doc) },
    async listDefinitions() { calls.push(['list']); return { definitions: [{ blueprintId: definition.id, name: definition.name, documentRevision: 'doc-1', semanticRevision: 'semantic-1' }] } },
    async inspectRun(id) { calls.push(['inspect', id]); return structuredClone(snapshot) },
    async validate() { return { ok: true, semanticRevision: 'semantic-1' } },
    async saveDefinition(id, json) { calls.push(['save', json]); doc.definitionJson = json; doc.documentRevision = 'doc-2'; doc.layoutRevision = 'layout-2'; return structuredClone(doc) },
  }
  const f = { states: [], refs: [], memos: [], cursor: 0, refCursor: 0, memoCursor: 0, calls, doc, definition, snapshot, dict: en, flow: { getNodes: () => [], fitView: async () => true, screenToFlowPosition: position => position } }
  f.t = (k, params = {}) => { assert.ok(Object.hasOwn(f.dict, k), `typed dictionary key ${k}`); return f.dict[k].replace(/\{([^}]+)\}/g, (_, p) => String(params[p] ?? `{${p}}`)) }
  const Panel = createBlueprintPanel({ hostLink: host, storage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) } })
  seat.active = f; f.shell = Panel({ t: f.t }); assert.equal(f.shell.type, 'provider')
  const entry = f.shell.children[0]
  f.render = () => { seat.active = f; f.cursor = f.refCursor = f.memoCursor = 0; return f.tree = entry.type({ t: f.t }) }
  f.render(); f.workspace = f.states[0]; assert.ok(f.workspace instanceof BlueprintWorkspace)
  await f.workspace.initialize(); await f.workspace.load(definition.id)
  f.workspace.runId = snapshot.runId; await f.workspace.inspect(); f.calls.length = 0; f.render()
  return f
}

const { executableNodeIds, flowAriaLabels, presentationGroupFrames, resourceKindTitle, runStateTitle } = await import('../../src/client/presentation.ts')
const { defaultAriaLabelConfig } = await import('@xyflow/system')

test('stable native translator switches canvas vocabulary without editor/provider/input/Inspector identity changes', async () => {
  const f = await fixture(), editor = f.workspace.editor
  flowOf(f).props.onSelectionChange({ nodes: [flowOf(f).props.nodes.find(n => n.id === editor.nodes[0].id)], edges: [] })
  const before = flowOf(f).props.nodes.filter(n => n.type === 'blueprint')
  const inspectorBefore = all(f.render(), n => typeof n.type === 'function' && n.props.node)[0]
  f.workspace.inputJson = '{"保留": "user buffer"}'
  f.dict = zh
  assert.equal(action(f, 'start-run').props['aria-label'], '运行')
  assert.equal(one(action(f, 'start-run'), n => n.type === 'svg').props['data-bp-icon'], 'run')
  assert.equal(flowOf(f).props.nodes.find(n => n.id === editor.nodes[0].id).data.label, '输入 1')
  assert.equal(flowOf(f).props.nodes.find(n => n.id === editor.nodes[0].id).data.kindTitle, '输入')
  assert.equal(f.workspace.editor, editor)
  assert.deepEqual(flowOf(f).props.nodes.filter(n => n.type === 'blueprint').map(n => [n.id, n.position, n.selected]), before.map(n => [n.id, n.position, n.selected]))
  assert.equal(f.workspace.inputJson, '{"保留": "user buffer"}')
  const after = all(f.render(), n => typeof n.type === 'function' && n.props.node)[0]
  assert.equal(after.type, inspectorBefore.type); assert.equal(after.props.key, editor.nodes[0].id)
  assert.equal(after.props.t, f.t); assert.equal(f.shell.children[0].props.t, f.t)
  assert.equal(flowOf(f).props.ariaLabelConfig['controls.fitView.ariaLabel'], zh['flow.controls.fitView.ariaLabel'])
  assert.deepEqual(f.calls, [], 'locale render must not replay a command')
})

test('group frame is presentation-only, isolated from executable selection/deletion and reversible history', async () => {
  const f = await fixture(), editor = f.workspace.editor, ids = editor.nodes.slice(0, 2).map(n => n.id)
  const semanticBefore = editor.exportDefinition().graph.nodes, positions = editor.nodes.map(n => [n.id, n.x, n.y])
  flowOf(f).props.onSelectionChange({ nodes: flowOf(f).props.nodes.filter(n => ids.includes(n.id)), edges: [] })
  action(f, 'group-selection').props.onClick()
  assert.equal(editor.groups.length, 1)
  assert.equal(editor.groups[0].label, '', 'default label must never persist translated copy')
  let frame = flowOf(f).props.nodes.find(n => n.type === 'presentationGroup')
  assert.ok(frame); assert.equal(frame.parentId, undefined); assert.equal(frame.selectable, false); assert.equal(frame.draggable, false)
  assert.equal(frame.data.groupId, editor.groups[0].id)
  assert.deepEqual(editor.exportDefinition().graph.nodes, semanticBefore); assert.deepEqual(editor.nodes.map(n => [n.id, n.x, n.y]), positions)
  flowOf(f).props.onNodesChange([{ type: 'select', id: frame.id, selected: true }, { type: 'position', id: frame.id, position: { x: 999, y: 999 } }])
  assert.deepEqual([...editor.selection], ids)
  flowOf(f).props.onSelectionChange({ nodes: [frame, ...flowOf(f).props.nodes.filter(n => ids.includes(n.id))], edges: [] })
  assert.deepEqual([...editor.selection], ids)
  const view = flowOf(f).props.nodeTypes.presentationGroup({ id: frame.id, data: frame.data })
  assert.equal(view.props['data-bp-group'], editor.groups[0].id)
  one(view, n => n.props['data-bp-action'] === `ungroup-${editor.groups[0].id}`).props.onClick()
  assert.equal(editor.groups.length, 0)
  action(f, 'undo').props.onClick(); assert.equal(editor.groups.length, 1)
  action(f, 'redo').props.onClick(); assert.equal(editor.groups.length, 0)
  action(f, 'undo').props.onClick(); await f.workspace.save()
  assert.equal(one(f.render(), n => n.props['data-bp-status-key']).props['data-bp-status-key'], 'status.saved')
  await f.workspace.load(f.definition.id)
  assert.equal(f.workspace.editor.groups.length, 1, 'group roundtrips through existing Save/load')
  assert.equal(one(f.render(), n => n.props['data-bp-status-key']).props['data-bp-status-key'], f.workspace.notice.key)
  assert.equal(flowOf(f).props.nodes.filter(n => n.type === 'presentationGroup').length, 1)
})

test('semantic edit suppresses stale overlay but retains durable details/revision; layout edits do not', async () => {
  const f = await fixture(), editor = f.workspace.editor, id = editor.nodes[0].id
  assert.equal(f.workspace.runOverlayEligible, true)
  editor.beginLayout(); editor.moveNode(id, 900, -40); editor.commitLayout()
  assert.equal(f.workspace.runOverlayEligible, true)
  assert.equal(flowOf(f).props.nodes.find(n => n.id === id).data.state, 'Succeeded')
  editor.updateNode(id, { name: '用户名称' })
  assert.equal(f.workspace.runOverlayEligible, false)
  assert.equal(flowOf(f).props.nodes.find(n => n.id === id).data.state, 'Not running')
  assert.equal(one(f.render(), n => n.props['data-bp-overlay']).props['data-bp-overlay'], 'suppressed')
  assert.equal(one(f.render(), n => Object.hasOwn(n.props, 'data-bp-run-revision')).children.at(-1), 'semantic-1')
  assert.ok(all(f.render(), n => n.props['data-bp-output'] === id).some(n => n.children.includes('{"原样":"payload"}')))
  assert.equal(flowOf(f).props.nodes.find(n => n.id === id).data.label, '用户名称')
  assert.deepEqual(f.calls, [])
})

const translate = dict => (key, params = {}) => { assert.ok(Object.hasOwn(dict, key)); return dict[key].replace(/\{([^}]+)\}/g, (_, name) => String(params[name])) }
const node = (id, x, y, extra = {}) => ({ id, kind: 'input', label: 'legacy', x, y, inputs: {}, outputs: { 原端口: 'unknown-type' }, ...extra })

test('every installed XYFlow aria seat is localized, live message params and unknown direction stay original', () => {
  assert.equal(en['flow.controls.fitView.ariaLabel'], 'Fit View')
  assert.equal(flowAriaLabels(translate(en))['controls.fitView.ariaLabel'], defaultAriaLabelConfig['controls.fitView.ariaLabel'])
  for (const dict of [zh, en]) {
    const aria = flowAriaLabels(translate(dict))
    assert.deepEqual(Object.keys(aria).sort(), Object.keys(defaultAriaLabelConfig).sort())
    for (const [key, value] of Object.entries(aria)) if (typeof value === 'string') assert.equal(value, dict[`flow.${key}`])
    assert.equal(aria['node.a11yDescription.ariaLiveMessage']({ direction: 'left', x: -12.5, y: 909 }), translate(dict)('flow.node.a11yDescription.ariaLiveMessage', { direction: dict['flow.direction.left'], x: -12.5, y: 909 }))
    assert.ok(aria['node.a11yDescription.ariaLiveMessage']({ direction: 'diagonal-未来', x: 1, y: 2 }).includes('diagonal-未来'))
  }
})

test('frame bounds enclose measured members, deduplicate IDs, skip missing members, and avoid executable-ID collisions', () => {
  const nodes = [node('a', -80, 100), node('b', 450, -30), node('bp:presentation-group:raw-group', 0, 0)]
  const before = structuredClone(nodes)
  const groups = [{ id: 'raw-group', label: '用户原样', nodeIds: ['a', 'b', 'a', 'missing'] }, { id: 'empty', label: 'empty', nodeIds: ['missing'] }]
  const frames = presentationGroupFrames(groups, nodes, [{ id: 'a', measured: { width: 330, height: 410 } }, { id: 'b', measured: { width: 250, height: 200 } }])
  assert.deepEqual(frames, [{ id: 'bp:presentation-group:raw-group:', groupId: 'raw-group', label: '用户原样', nodeIds: ['a', 'b'], x: -104, y: -98, width: 828, height: 632 }])
  assert.deepEqual(nodes, before); assert.equal(frames[0].parentId, undefined)
  assert.deepEqual(executableNodeIds(nodes, [frames[0].id, 'a', 'a', 'missing', 'b']), ['a', 'b'])
  const fallback = presentationGroupFrames([groups[0]], nodes, [{ id: 'a', measured: { width: NaN, height: -1 } }])[0]
  assert.ok(Number.isFinite(fallback.width) && Number.isFinite(fallback.height))
  const ports = node('many', 0, 0, { inputs: { a: 'string', b: 'string', c: 'raw' }, definition: { id: 'many', kind: 'humanDecision', branches: ['批准', '拒绝', 'maybe'] } })
  const size = presentationGroupFrames([{ id: 'g', label: '', nodeIds: ['many'] }], [ports])[0]
  assert.equal(size.height, 183 + 160 + 92, 'unmeasured multi-port node geometry includes both data/control rows')
})

test('known states/resource kinds translate while future values remain raw', () => {
  for (const dict of [zh, en]) {
    const t = translate(dict)
    for (const state of ['queued', 'preparing', 'ready', 'running', 'cancelling', 'recovery_required', 'timed_out', 'waiting_input', 'succeeded', 'failed', 'cancelled', 'skipped']) assert.equal(runStateTitle(state, t), dict[`state.${state}`])
    for (const kind of ['agent', 'prompt', 'skill', 'schema', 'script', 'mcp', 'subflow']) assert.equal(resourceKindTitle(kind, t), dict[`resource.kind.${kind}`])
    assert.equal(runStateTitle('future-state 原样', t), 'future-state 原样')
    assert.equal(resourceKindTitle('future-kind 原样', t), 'future-kind 原样')
  }
})

test('palette searches both language aliases and kinds, retains query/Run-input across locale switches', async () => {
  const f = await fixture(), search = () => one(f.render(), n => Object.hasOwn(n.props, 'data-bp-palette-search'))
  for (const [query, kind] of [['输入', 'input'], ['Agent task', 'agentTask'], ['审批', 'humanDecision'], ['output', 'output']]) {
    search().props.onChange({ target: { value: query } })
    const palette = all(f.render(), n => n.props.className === 'bp-palette-entry')
    assert.equal(palette.length, 1); assert.equal(palette[0].props['data-bp-action'], `add-${kind}`)
  }
  one(f.render(), n => Object.hasOwn(n.props, 'data-bp-run-input')).props.onChange({ target: { value: '{invalid user buffer' } })
  f.dict = zh
  assert.equal(search().props.value, 'output')
  assert.equal(one(f.render(), n => Object.hasOwn(n.props, 'data-bp-run-input')).props.value, '{invalid user buffer')
  assert.equal(one(action(f, 'add-output'), n => n.type === 'strong').children[0], '输出')
  const outputIcon = one(action(f, 'add-output'), n => n.type === 'svg')
  assert.equal(outputIcon.props['data-bp-icon'], 'output'); assert.equal(outputIcon.props['aria-hidden'], true)
  assert.deepEqual(f.calls, [])
})

test('node/port display preserves explicit empty/user names, raw unknown kinds, refs, types and branch labels', async () => {
  const f = await fixture(), editor = f.workspace.editor
  editor.updateNode(editor.nodes[0].id, { name: '', agentRef: 'raw-资源-ref', outputs: { '原.port:': 'UnKnown Type' }, branches: ['用户.branch'] })
  const future = editor.addNode({ kind: 'opaque.future', label: 'legacy not a user name', x: 800, y: 3, inputs: {}, outputs: {} })
  f.dict = zh
  const nodes = flowOf(f).props.nodes
  const builtin = nodes.find(n => n.id === editor.nodes[0].id), unknown = nodes.find(n => n.id === future.id)
  assert.equal(builtin.data.label, ''); assert.equal(builtin.data.summary, 'raw-资源-ref')
  assert.equal(unknown.data.kindTitle, 'opaque.future'); assert.equal(unknown.data.label, 'opaque.future 3')
  const view = flowOf(f).props.nodeTypes.blueprint({ id: builtin.id, data: builtin.data, selected: true })
  const handle = one(view, n => n.props['data-bp-port-out'] === `${builtin.id}:data:原.port:`)
  assert.equal(handle.props.id, 'data:原.port:'); assert.equal(handle.props['aria-label'], `${builtin.id} 输出 数据 原.port:`)
  assert.ok(all(view, n => n.type === 'span').some(n => n.children.includes('原.port: · UnKnown Type')))
  assert.ok(all(view, n => n.type === 'span').some(n => n.children.includes('用户.branch')))
  assert.equal(editor.exportDefinition().graph.nodes[0].name, '')
})

test('typed connection feedback and workspace notices retranslate without changing reasons/payload', async () => {
  const f = await fixture(), flow = flowOf(f)
  flow.props.onConnect({ source: 'in', sourceHandle: 'data:request', target: 'out', targetHandle: 'control:control' })
  const feedback = () => one(f.render(), n => n.props['data-bp-status'] === 'message')
  assert.equal(feedback().props['data-bp-status-key'], 'connection.edgeKindMismatch')
  assert.equal(feedback().children[0], en['connection.edgeKindMismatch'])
  f.dict = zh
  assert.equal(feedback().children[0], zh['connection.edgeKindMismatch'])
  flowOf(f).props.onConnect({ source: 'in', sourceHandle: 'bogus:missing', target: 'out', targetHandle: 'data:value' })
  assert.equal(feedback().props['data-bp-status-key'], 'connection.undeclaredPort')
  const g = await fixture(); g.workspace.notice = { key: 'status.error', params: { code: 'blueprint/transport-unavailable' } }; g.dict = zh
  const status = one(g.render(), n => n.props['data-bp-status-key'])
  assert.equal(status.props['data-bp-status-key'], 'status.error')
  assert.equal(status.children[0], '操作失败：blueprint/transport-unavailable')
  assert.deepEqual(g.workspace.notice.params, { code: 'blueprint/transport-unavailable' })
})

test('frame measurement refresh is display-only and locale retranslation never renames persisted groups', async () => {
  const f = await fixture(), editor = f.workspace.editor
  editor.setSelection(['in']); action(f, 'group-selection').props.onClick()
  const original = editor.exportDefinition(), frame = flowOf(f).props.nodes.find(n => n.type === 'presentationGroup')
  f.flow.getNodes = () => [{ id: 'in', measured: { width: 420, height: 600 } }]
  flowOf(f).props.onNodesChange([{ type: 'dimensions', id: 'in', dimensions: { width: 420, height: 600 } }])
  const measured = flowOf(f).props.nodes.find(n => n.type === 'presentationGroup')
  assert.equal(measured.id, frame.id); assert.equal(measured.style.width, 468); assert.equal(measured.style.height, 692)
  f.dict = zh
  assert.equal(flowOf(f).props.nodes.find(n => n.type === 'presentationGroup').data.label, '展示分组')
  assert.deepEqual(editor.exportDefinition(), original)
  assert.equal(f.workspace.runOverlayEligible, true)
  // Even a synthetic renderer event cannot delete a group or executable graph.
  flowOf(f).props.onSelectionChange({ nodes: [measured], edges: [] })
  assert.deepEqual([...editor.selection], [])
  one(f.render(), n => n.props['data-bp-canvas'] === 'root').props.onKeyDown({ target: null, key: 'Delete', preventDefault() {} })
  assert.deepEqual(editor.exportDefinition(), original)
})


test('installed XYFlow retains measured dimensions and handle bounds across localized controlled-node refresh', async () => {
  const f = await fixture(), editor = f.workspace.editor
  const definition = editor.exportDefinition(), nodeId = editor.nodes[0].id
  flowOf(f).props.onNodesChange([{ type: 'dimensions', id: nodeId, dimensions: { width: 220, height: 240 } }])
  const lookup = new Map(), parents = new Map()
  adoptUserNodes(flowOf(f).props.nodes, lookup, parents)
  const bounds = { source: [{ id: 'data:request', x: 210, y: 80, width: 10, height: 10, position: 'right' }], target: [] }
  lookup.get(nodeId).internals.handleBounds = bounds
  const before = lookup.get(nodeId)
  f.dict = zh
  const refreshed = flowOf(f).props.nodes
  assert.notEqual(refreshed.find(n => n.id === nodeId).data, before.data)
  adoptUserNodes(refreshed, lookup, parents)
  assert.deepEqual(lookup.get(nodeId).measured, { width: 220, height: 240 })
  assert.equal(lookup.get(nodeId).internals.handleBounds, bounds)
  assert.equal(lookup.get(nodeId).data.kindTitle, '输入')
  assert.deepEqual(lookup.get(nodeId).internals.positionAbsolute, before.internals.positionAbsolute)
  assert.deepEqual(editor.exportDefinition(), definition, 'renderer dimensions must never enter saved definition')
  // Negative control proves this is the installed reset boundary, not a label-only assertion.
  adoptUserNodes(refreshed.map(n => { const { measured: _measured, ...unmeasured } = n; return unmeasured }), lookup, parents)
  assert.equal(lookup.get(nodeId).internals.handleBounds, undefined)
})
