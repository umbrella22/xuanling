// Actual production Panel closure + actual BlueprintWorkspace/GraphEditor.
// React/Flow hook seats, frame scheduling and confirm are controlled below.
// Effects (DOM styles/poll timers) are not mounted; callbacks are SOURCE probes,
// NOT native browser/pointer acceptance. Main owns the unchanged DSH gate.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { canvasDefinitions } from '../../../../../test/blueprint/capabilities/canvas-fixtures.mjs'
import { decodeDefinition, validateDefinition } from '../../src/definition/index.ts'
import { en } from '../../src/client/locales.ts'
import { BlueprintRemoteError } from '../../src/client/remote.ts'
import { BlueprintWorkspace, draftKey, runBindingKey } from '../../src/client/workspace.ts'

// Explicit injected-locale fixture seat, not native DSH locale acceptance.
const fixtureT = (key, params = {}) => {
  assert.ok(Object.hasOwn(en, key), `existing English dictionary key: ${key}`)
  return en[key].replace(/\{([^}]+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
}

const seat = { active: null }
const seatKey = Symbol.for('xuanling.blueprint.test.foreground-navigation')
globalThis[seatKey] = seat
seat.react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  memo: component => component,
  useState(initial) {
    const f = seat.active, i = f.stateCursor++
    if (!(i in f.states)) f.states[i] = typeof initial === 'function' ? initial() : initial
    return [f.states[i], update => { f.states[i] = typeof update === 'function' ? update(f.states[i]) : update }]
  },
  useRef(initial) { const f = seat.active, i = f.refCursor++; return f.refs[i] ??= { current: initial } },
  useMemo: factory => factory(), useCallback: callback => callback, useEffect() {},
}
const moduleUrl = source => `data:text/javascript,${encodeURIComponent(source)}`
const reactUrl = moduleUrl(`export default globalThis[Symbol.for('xuanling.blueprint.test.foreground-navigation')].react`)
const flowUrl = moduleUrl(`export const useReactFlow = () => globalThis[Symbol.for('xuanling.blueprint.test.foreground-navigation')].active.flow;
export const Position = { Left: 'left', Right: 'right' }, MarkerType = { ArrowClosed: 'arrowclosed' };
export const ReactFlow = 'flow', ReactFlowProvider = 'provider', Background = 'background', Controls = 'controls', MiniMap = 'minimap', Handle = 'handle', NodeResizer = 'resizer', BaseEdge = 'base-edge'; export const getSmoothStepPath=()=>['M 0 0 L 1 1',0,0];`)
const panelUrl = new URL('../../src/client/panel.ts', import.meta.url).href
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === panelUrl && ['react', '@xyflow/react'].includes(specifier)) return { url: specifier === 'react' ? reactUrl : flowUrl, shortCircuit: true }
  return next(specifier, context)
} })
let createBlueprintPanel
try { ({ createBlueprintPanel } = await import(panelUrl)) }
finally { hooks.deregister() }
const globals = new Map(['window', 'requestAnimationFrame'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
globalThis.window = { confirm: message => { seat.active.confirmations.push(message); return true } }
globalThis.requestAnimationFrame = callback => { seat.active.frames.push(callback); return seat.active.frames.length }
test.after(() => {
  delete globalThis[seatKey]
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})

const ALPHA = 'canvas-alpha', BETA = 'canvas-beta'
const runId = id => `run-${id}`
const snapshot = (id, seq = 7) => ({ runId: runId(id), state: 'succeeded', seq, definitionRevision: `semantic-${id}`,
  attempts: [{ nodeId: 'out', state: 'succeeded', attempt: 1, outputJson: '"known fixture output"' }], logTail: [{ seq, kind: 'state' }] })
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function findAll(tree, predicate) {
  if (!tree || typeof tree !== 'object') return []
  return [...(predicate(tree) ? [tree] : []), ...(tree.children ?? []).flat(Infinity).flatMap(child => findAll(child, predicate))]
}
function one(tree, predicate) {
  const matches = findAll(tree, predicate)
  assert.equal(matches.length, 1, 'fixture must locate the single actual production control')
  return matches[0]
}
// Input adaptation only: walk the actual public More/menu group callbacks.
// The overlay has its own renderer seat; Panel state and all behavior oracles stay intact.
function publicTree(f, id) {
  const current = f.render()
  if (findAll(current, n => n.props['data-bp-action'] === id).length) return current
  let entry = findAll(current, n => n.props.overlay?.kind === 'more-menu')[0]
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
function publicAction(tree, id) {
  return one(publicTree(seat.active, id), n => n.type === 'button' && n.props['data-bp-action'] === id)
}
const specs = [
  ['Configured blueprint', tree => one(tree, n => n.type === 'select' && n.props['aria-label'] === 'Configured blueprint')],
  ['Refresh library', tree => publicAction(tree, 'refresh-library')],
  ['Inspect input', tree => one(tree, n => n.type === 'input' && n.props['aria-label'] === 'Inspect run ID')],
  ['Inspect submit', tree => one(tree, n => n.type === 'button' && n.props['data-bp-action'] === 'inspect-run')],
]
const action = (tree, id) => one(tree, n => n.type === 'button' && n.props['data-bp-action'] === id)
function assertActionability(f, disabled) {
  const tree = f.render()
  for (const [label, locate] of specs) assert.equal(locate(tree).props.disabled === true, disabled, `${label}: native disabled must follow foreground workspace.busy only`)
  assert.equal(specs[2][1](tree).props.name, 'runId')
  assert.equal(specs[3][1](tree).props.type, 'submit')
  assert.equal(typeof one(tree, n => n.type === 'form' && n.children.includes(specs[2][1](tree))).props.onSubmit, 'function')
}
const mutations = f => f.calls.filter(([method]) => ['saveDefinition', 'startRun', 'cancelRun', 'decide'].includes(method))

async function fixture({ loaded = true, boundRuns = true, hostAvailable = true } = {}) {
  const definitions = canvasDefinitions().filter(d => [ALPHA, BETA].includes(d.id))
  for (const definition of definitions) validateDefinition(decodeDefinition(JSON.stringify(definition)))
  const documents = new Map(definitions.map(d => [d.id, { blueprintId: d.id, definitionJson: JSON.stringify(d), documentRevision: `document-${d.id}`, semanticRevision: `semantic-${d.id}`, layoutRevision: `layout-${d.id}` }]))
  const f = { states: [], refs: [], stateCursor: 0, refCursor: 0, calls: [], reads: new Map(), values: new Map(), confirmations: [], frames: [], fits: [] }
  f.flow = { fitView: options => { f.fits.push(options); return Promise.resolve(true) } }
  for (const id of boundRuns ? [ALPHA, BETA] : []) f.values.set(runBindingKey(id), JSON.stringify({ blueprintId: id, runId: runId(id) }))
  const host = {
    async listDefinitions() { f.calls.push(['listDefinitions']); if (f.listRead) await f.listRead.promise; return { definitions: definitions.map(d => ({ blueprintId: d.id, name: d.name, documentRevision: `document-${d.id}`, semanticRevision: `semantic-${d.id}` })) } },
    async loadDefinition(id) { f.calls.push(['loadDefinition', id]); assert.ok(documents.has(id), 'configured ID fixture precondition'); return structuredClone(documents.get(id)) },
    async inspectRun(id) { f.calls.push(['inspectRun', id]); assert.ok([runId(ALPHA), runId(BETA)].includes(id), 'known Run fixture precondition'); if (f.reads.has(id)) return f.reads.get(id).promise; return snapshot(id === runId(ALPHA) ? ALPHA : BETA) },
    async validate(json) { f.calls.push(['validate', json]); const d = decodeDefinition(json); validateDefinition(d); return { ok: true, semanticRevision: `semantic-${d.id}` } },
  }
  for (const method of ['saveDefinition', 'startRun', 'cancelRun', 'decide']) host[method] = async (...args) => { f.calls.push([method, ...args]); assert.fail(`READ_ONLY_ACTION_REPLAYED_${method}`) }
  const storage = { getItem: key => f.values.get(key) ?? null, setItem: (key, value) => f.values.set(key, value) }
  const Panel = createBlueprintPanel({ hostLink: hostAvailable ? host : undefined, storage })
  seat.active = f
  const shell = Panel({ t: fixtureT })
  assert.equal(shell.type, 'provider', 'actual panel owns the React Flow provider')
  const WorkspacePanel = shell.children[0].type
  f.render = () => { seat.active = f; f.stateCursor = 0; f.refCursor = 0; return f.tree = WorkspacePanel({ t: fixtureT }) }
  f.render(); f.workspace = f.states[0]
  assert.ok(f.workspace instanceof BlueprintWorkspace, 'no Workspace model double')
  assert.equal(f.workspace.host, hostAvailable ? host : undefined)
  await f.workspace.initialize()
  if (loaded && hostAvailable) await f.workspace.load(BETA)
  f.calls.length = 0
  f.render()
  return f
}
// Observe settlement through the actual workspace subscription, not a timer or
// an invented return value for Panel's fire-and-forget perform callback.
function foreground(f, callback) {
  let started = false, resolve
  const done = new Promise(yes => { resolve = yes })
  const off = f.workspace.subscribe(() => {
    if (f.workspace.busy) started = true
    else if (started) { off(); resolve() }
  })
  callback(f.render())
  assert.equal(started, true, 'actual foreground perform must emit busy')
  return done
}
function heldForegroundInspect(f) {
  assert.equal(f.workspace.runId, runId(BETA))
  assert.equal(f.workspace.model.view.state, 'succeeded')
  const held = deferred(); f.reads.set(runId(BETA), held)
  const done = foreground(f, tree => {
    const retry = action(tree, 'retry-inspect'); assert.equal(retry.props.disabled, false); retry.props.onClick()
  })
  assert.equal(f.workspace.busy, true)
  assert.deepEqual(f.calls, [['inspectRun', runId(BETA)]], 'real inspect request is pending')
  assert.equal(action(f.render(), 'save-layout').props.disabled, true, 'existing Save is the positive busy control')
  return { held, done }
}
async function navigate(f, id) {
  findAll(f.render(), n => n.props.overlay?.kind === 'more-menu')[0]?.props.onClose()
  const select = specs[0][1](f.render())
  assert.notEqual(select.props.disabled, true, 'source invokes navigation only on an actionable production select')
  const done = foreground(f, () => select.props.onChange({ target: { value: id } }))
  await done
  assert.equal(f.workspace.blueprintId, id)
  assert.equal(specs[0][1](f.render()).props.value, id)
  assertActionability(f, false)
}

for (const [label, locate] of specs) {
  test(`foreground inspect disables actual production ${label}`, async () => {
    const f = await fixture()
    const before = { graph: f.workspace.editor.exportDefinition(), view: structuredClone(f.workspace.model.view), values: [...f.values] }
    const { held, done } = heldForegroundInspect(f)
    try {
      assert.equal(locate(f.render()).props.disabled, true, `FOREGROUND_BUSY_CONTROL_ENABLED: ${label} must expose native disabled while the real foreground inspect is pending`)
      assert.equal(f.workspace.runId, runId(BETA))
      assert.deepEqual(f.workspace.editor.exportDefinition(), before.graph)
      assert.deepEqual(f.workspace.model.view, before.view)
      assert.deepEqual([...f.values], before.values, 'disabled Inspect cannot change the Run/draft binding')
      assert.deepEqual(mutations(f), [])
    } finally { held.resolve(snapshot(BETA, 8)); await done }
  })
}

for (const mode of ['success', 'failure']) {
  test(`foreground ${mode} settlement restores all four controls and production navigation`, async () => {
    const f = await fixture()
    // Independent ID-scoped draft contents, using the real editor/persistence.
    const node = f.workspace.editor.nodes[0]
    f.workspace.editor.moveNode(node.id, 113.431, -123.084); f.workspace.editor.commitLayout()
    const betaDraft = f.values.get(draftKey(BETA)), betaGraph = f.workspace.editor.exportDefinition()
    const { held, done } = heldForegroundInspect(f)
    try { assertActionability(f, true) }
    finally {
      if (mode === 'failure') held.reject(new BlueprintRemoteError('blueprint/transport-unavailable'))
      else held.resolve(snapshot(BETA, 8))
      await done
    }
    assert.equal(f.workspace.busy, false)
    assertActionability(f, false)
    if (mode === 'failure') {
      const status = one(f.tree, n => n.props['data-bp-status'] === 'message')
      assert.equal(f.workspace.notice.params.code, 'blueprint/transport-unavailable')
      assert.equal(status.props['data-bp-status-key'], 'status.error')
      assert.equal(status.children[0], fixtureT('status.error', { code: 'blueprint/transport-unavailable' }))
      assert.equal(f.workspace.model.connectionState, 'stale', 'genuine read failure stays honest')
      assert.deepEqual(f.workspace.model.view, snapshot(BETA), 'last durable facts survive failure')
    } else {
      assert.equal(f.workspace.model.connectionState, 'connected')
      assert.deepEqual(f.workspace.model.view, snapshot(BETA, 8))
    }
    f.reads.delete(runId(BETA))
    await navigate(f, ALPHA)
    assert.equal(f.workspace.runId, runId(ALPHA)); assert.deepEqual(f.workspace.model.view, snapshot(ALPHA))
    assert.deepEqual(f.calls.filter(([method]) => method === 'loadDefinition'), [['loadDefinition', ALPHA]], 'no selection is silently dropped after settlement')
    assert.equal(f.values.get(draftKey(BETA)), betaDraft)
    assert.equal(f.values.has(draftKey(ALPHA)), false, 'beta edits must not become an alpha draft')
    assert.equal(f.workspace.editor.exportDefinition().id, ALPHA)
    assert.deepEqual(f.workspace.editor.exportDefinition().metadata, { retained: { note: 'Keep all existing document fields' } })
    await navigate(f, BETA)
    assert.deepEqual(f.workspace.editor.exportDefinition(), betaGraph)
    assert.equal(f.workspace.runId, runId(BETA)); assert.deepEqual(f.workspace.model.view, snapshot(BETA))
    for (const id of [ALPHA, BETA]) assert.deepEqual(JSON.parse(f.values.get(runBindingKey(id))), { blueprintId: id, runId: runId(id) })
    assert.deepEqual(mutations(f), [], 'success/failure/reopen never replay save/start/cancel/decision')
    assert.equal(f.confirmations.length, 1, 'existing unsaved-draft confirmation is preserved')
    assert.equal(f.frames.length, 2, 'existing post-navigation fit scheduling is preserved')
  })
}

for (const outcome of ['success', 'failure']) {
  test(`background inspect ${outcome} alone leaves navigation actionable and late beta result cannot contaminate alpha`, async () => {
    const f = await fixture(), held = deferred()
    f.reads.set(runId(BETA), held)
    const read = f.workspace.inspect()
    const observed = read.then(() => ({ ok: true }), error => ({ ok: false, error }))
    assert.equal(f.workspace.busy, false, 'background read is not perform/network-wide busy')
    assert.deepEqual(f.calls, [['inspectRun', runId(BETA)]])
    assertActionability(f, false)
    await navigate(f, ALPHA)
    const graph = f.workspace.editor.exportDefinition(), values = [...f.values], view = structuredClone(f.workspace.model.view)
    if (outcome === 'failure') held.reject(new BlueprintRemoteError('blueprint/transport-unavailable'))
    else held.resolve(snapshot(BETA, 99))
    const result = await observed
    assert.equal(result.ok, outcome === 'success')
    if (!result.ok) assert.equal(result.error.code, 'blueprint/transport-unavailable')
    assert.equal(f.workspace.busy, false); assertActionability(f, false)
    assert.equal(f.workspace.blueprintId, ALPHA); assert.equal(f.workspace.runId, runId(ALPHA))
    assert.deepEqual(f.workspace.model.view, view); assert.equal(f.workspace.model.connectionState, 'connected')
    assert.deepEqual(f.workspace.editor.exportDefinition(), graph); assert.deepEqual([...f.values], values)
    assert.deepEqual(mutations(f), [])
  })
}

test('production Refresh library after inspect settlement dispatches once without rebinding or replay', async () => {
  const f = await fixture(), { held, done } = heldForegroundInspect(f)
  held.resolve(snapshot(BETA, 8)); await done
  assertActionability(f, false)
  const before = { graph: f.workspace.editor.exportDefinition(), view: structuredClone(f.workspace.model.view), values: [...f.values] }
  const refresh = specs[1][1](f.render())
  await foreground(f, () => refresh.props.onClick())
  assert.equal(f.workspace.busy, false); assertActionability(f, false)
  assert.deepEqual(f.calls, [['inspectRun', runId(BETA)], ['listDefinitions']])
  assert.equal(f.workspace.runId, runId(BETA)); assert.equal(f.workspace.blueprintId, BETA)
  assert.deepEqual(f.workspace.editor.exportDefinition(), before.graph); assert.deepEqual(f.workspace.model.view, before.view); assert.deepEqual([...f.values], before.values)
  assert.deepEqual(mutations(f), [])
})

for (const options of [{ loaded: false }, { boundRuns: false }, { hostAvailable: false }]) {
  test(`inactive controls remain actionable with ${JSON.stringify(options)} and original no-document/no-Run guards remain`, async () => {
    const f = await fixture(options)
    assert.equal(f.workspace.busy, false); assertActionability(f, false)
    assert.equal(f.workspace.runId, null); assert.equal(f.workspace.model.view, null)
    assert.equal(action(f.tree, 'cancel-run').props.disabled, true)
    assert.equal(action(f.tree, 'retry-inspect').props.disabled, true)
    assert.equal(action(f.tree, 'save-layout').props.disabled, !f.workspace.definition)
    assert.equal(action(f.tree, 'start-run').props.disabled, !f.workspace.definition)
    assert.deepEqual(f.calls, []); assert.deepEqual(mutations(f), [])
  })
}

test('foreground library read without a document/Run disables all four controls only until settlement', async () => {
  const f = await fixture({ loaded: false }), held = deferred()
  f.listRead = held
  const before = [...f.values]
  const done = foreground(f, tree => specs[1][1](tree).props.onClick())
  try {
    assert.equal(f.workspace.busy, true); assertActionability(f, true)
    assert.equal(f.workspace.runId, null); assert.equal(f.workspace.definition, null)
    assert.equal(action(f.tree, 'save-layout').props.disabled, true)
  } finally { held.resolve(); await done }
  assert.equal(f.workspace.busy, false); assertActionability(f, false)
  assert.deepEqual(f.calls, [['listDefinitions']]); assert.deepEqual([...f.values], before)
  assert.deepEqual(mutations(f), [])
})
