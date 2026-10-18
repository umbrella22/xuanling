// Actual production Panel closure + actual BlueprintWorkspace/GraphEditor.
// React/Flow hook seats, frame scheduling and confirm are controlled below.
// Only the local FlowApiBridge effect is mounted; DOM styles/poll timers are not.
// Callbacks are SOURCE probes,
// NOT native browser/pointer acceptance. Main owns the unchanged DSH gate.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { canvasDefinitions } from '../../../../../test/blueprint/capabilities/canvas-fixtures.mjs'
import { decodeDefinition, validateDefinition } from '../../src/definition/index.ts'
import { en } from '../../src/client/shared/i18n/locales.ts'
import { BlueprintRemoteError } from '../../src/client/adapters/host/remote.ts'
import { BlueprintWorkspace, draftKey, runBindingKey } from '../../src/client/features/authoring/logic/workspace/workspace-controller.ts'

// Explicit injected-locale fixture seat, not native DSH locale acceptance.
const fixtureT = (key, params = {}) => {
  assert.ok(Object.hasOwn(en, key), `existing English dictionary key: ${key}`)
  return en[key].replace(/\{([^}]+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
}

const seat = { active: null }
const seatKey = Symbol.for('xuanling.blueprint.test.foreground-navigation')
globalThis[seatKey] = seat
seat.react = {
  // The controlled seat evaluates CanvasSurface because it is a pure
  // composition component with no hooks of its own. Other function
  // components remain opaque so FlowApiBridge is mounted explicitly below.
  createElement: (type, props, ...children) =>
    type?.name === 'CanvasSurface' ? type(props ?? {}) : { type, props: props ?? {}, children: children.length ? children : [props?.children] },
  memo: component => component,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useState(initial) {
    const f = seat.active,
      i = f.stateCursor++
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
  useMemo: factory => factory(),
  useCallback: callback => callback,
  useEffect(effect) {
    if (seat.bridge) effect()
  }
}
const moduleUrl = source => `data:text/javascript,${encodeURIComponent(source)}`
const reactUrl = moduleUrl(`export default globalThis[Symbol.for('xuanling.blueprint.test.foreground-navigation')].react`)
const flowUrl = moduleUrl(`export const useReactFlow = () => globalThis[Symbol.for('xuanling.blueprint.test.foreground-navigation')].active.flow;
export const Position = { Left: 'left', Right: 'right' }, MarkerType = { ArrowClosed: 'arrowclosed' };
export const ReactFlow = 'flow', ReactFlowProvider = 'provider', Background = 'background', Controls = 'controls', MiniMap = 'minimap', Handle = 'handle', NodeResizer = 'resizer', BaseEdge = 'base-edge'; export const getSmoothStepPath=()=>['M 0 0 L 1 1',0,0];`)
const panelUrl = new URL('../../src/client/features/authoring/ui/panel/panel-composition.tsx', import.meta.url).href
const panelControllerUrl = new URL('../../src/client/features/authoring/ui/panel/panel-controller.tsx', import.meta.url).href
const canvasSurfaceUrl = new URL('../../src/client/features/authoring/ui/canvas/canvas-surface.tsx', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (
      (context.parentURL === panelUrl ||
        context.parentURL === panelControllerUrl ||
        context.parentURL === canvasSurfaceUrl ||
        (specifier === 'react' && context.parentURL?.includes('/src/client/features/authoring/ui/panel/'))) &&
      ['react', '@xyflow/react'].includes(specifier)
    )
      return { url: specifier === 'react' ? reactUrl : flowUrl, shortCircuit: true }
    return next(specifier, context)
  }
})
let createBlueprintPanel
try {
  ;({ createBlueprintPanel } = await import(panelUrl))
} finally {
  hooks.deregister()
}
const globals = new Map(['window', 'requestAnimationFrame'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
globalThis.window = {
  confirm: message => {
    seat.active.confirmations.push(message)
    return true
  }
}
globalThis.requestAnimationFrame = callback => {
  seat.active.frames.push(callback)
  return seat.active.frames.length
}
test.after(() => {
  delete globalThis[seatKey]
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})

const ALPHA = 'canvas-alpha',
  BETA = 'canvas-beta'
const runId = id => `run-${id}`
const snapshot = (id, seq = 7) => ({
  runId: runId(id),
  state: 'succeeded',
  seq,
  definitionRevision: `semantic-${id}`,
  attempts: [{ nodeId: 'out', state: 'succeeded', attempt: 1, outputJson: '"known fixture output"' }],
  logTail: [{ seq, kind: 'state' }]
})
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
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
  if (!entry) {
    one(current, n => n.props['data-bp-action'] === 'more-actions').props.onClick()
    entry = one(f.render(), n => n.props.overlay?.kind === 'more-menu')
  }
  const group = ['export-blueprint', 'import-blueprint'].includes(id) ? 'files' : ['motion-toggle', 'toggle-minimap'].includes(id) ? 'view' : 'tools'
  if (f.publicMenu?.key !== entry.props.key) f.publicMenu = { key: entry.props.key, states: [], refs: [], cursor: 0, refCursor: 0 }
  const state = f.publicMenu
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'fragment',
    useState(initial) {
      const i = state.cursor++
      if (!(i in state.states)) state.states[i] = typeof initial === 'function' ? initial() : initial
      return [state.states[i], v => (state.states[i] = typeof v === 'function' ? v(state.states[i]) : v)]
    },
    useRef(initial) {
      return (state.refs[state.refCursor++] ??= { current: initial })
    },
    useEffect() {}
  }
  const render = () => {
    state.cursor = state.refCursor = 0
    return entry.type({ ...entry.props, React })
  }
  one(render(), n => n.props['data-bp-menu-group'] === group).props.onClick()
  return render()
}
function publicAction(tree, id) {
  return one(publicTree(seat.active, id), n => n.type === 'button' && n.props['data-bp-action'] === id)
}
const specs = [
  ['Blueprint library', tree => one(tree, n => n.type?.name === 'StyledSelect' && n.props['aria-label'] === 'Blueprint library')],
  ['Refresh library', tree => publicAction(tree, 'refresh-library')],
  ['Inspect input', tree => one(tree, n => n.type === 'input' && n.props['aria-label'] === 'Inspect run ID')],
  ['Inspect submit', tree => one(tree, n => n.type === 'button' && n.props['data-bp-action'] === 'inspect-run')]
]
const action = (tree, id) => one(tree, n => n.type === 'button' && n.props['data-bp-action'] === id)
function assertActionability(f, disabled) {
  const tree = f.render()
  for (const [label, locate] of specs)
    assert.equal(locate(tree).props.disabled === true, disabled, `${label}: native disabled must follow foreground workspace.busy only`)
  assert.equal(specs[2][1](tree).props.name, 'runId')
  assert.equal(specs[3][1](tree).props.type, 'submit')
  assert.equal(typeof one(tree, n => n.type === 'form' && n.children.includes(specs[2][1](tree))).props.onSubmit, 'function')
}
const mutations = f => f.calls.filter(([method]) => ['saveDefinition', 'startRun', 'cancelRun', 'decide'].includes(method))

async function fixture({ loaded = true, boundRuns = true, hostAvailable = true } = {}) {
  const definitions = canvasDefinitions().filter(d => [ALPHA, BETA].includes(d.id))
  for (const definition of definitions) validateDefinition(decodeDefinition(JSON.stringify(definition)))
  const documents = new Map(
    definitions.map(d => [
      d.id,
      {
        blueprintId: d.id,
        definitionJson: JSON.stringify(d),
        documentRevision: `document-${d.id}`,
        semanticRevision: `semantic-${d.id}`,
        layoutRevision: `layout-${d.id}`
      }
    ])
  )
  const f = { states: [], refs: [], stateCursor: 0, refCursor: 0, calls: [], reads: new Map(), values: new Map(), confirmations: [], frames: [], fits: [] }
  f.flow = {
    fitView: options => {
      f.fits.push(options)
      return Promise.resolve(true)
    }
  }
  for (const id of boundRuns ? [ALPHA, BETA] : []) f.values.set(runBindingKey(id), JSON.stringify({ blueprintId: id, runId: runId(id) }))
  const host = {
    async listDefinitions() {
      f.calls.push(['listDefinitions'])
      if (f.listRead) await f.listRead.promise
      return {
        definitions: definitions.map(d => ({ blueprintId: d.id, name: d.name, documentRevision: `document-${d.id}`, semanticRevision: `semantic-${d.id}` }))
      }
    },
    async loadDefinition(id) {
      f.calls.push(['loadDefinition', id])
      assert.ok(documents.has(id), 'configured ID fixture precondition')
      return structuredClone(documents.get(id))
    },
    async inspectRun(id) {
      f.calls.push(['inspectRun', id])
      assert.ok([runId(ALPHA), runId(BETA)].includes(id), 'known Run fixture precondition')
      if (f.reads.has(id)) return f.reads.get(id).promise
      return snapshot(id === runId(ALPHA) ? ALPHA : BETA)
    },
    async validate(json) {
      f.calls.push(['validate', json])
      const d = decodeDefinition(json)
      validateDefinition(d)
      return { ok: true, semanticRevision: `semantic-${d.id}` }
    }
  }
  for (const method of ['saveDefinition', 'startRun', 'cancelRun', 'decide'])
    host[method] = async (...args) => {
      f.calls.push([method, ...args])
      assert.fail(`READ_ONLY_ACTION_REPLAYED_${method}`)
    }
  const storage = { getItem: key => f.values.get(key) ?? null, setItem: (key, value) => f.values.set(key, value) }
  const Panel = createBlueprintPanel({ hostLink: hostAvailable ? host : undefined, storage })
  seat.active = f
  // Root owns Workspace/subscription; the composition child has its own hook seats.
  const panelSeat = { states: [], refs: [], stateCursor: 0, refCursor: 0 }
  f.render = () => {
    seat.active = f
    f.stateCursor = 0
    f.refCursor = 0
    const entry = Panel({ t: fixtureT })
    seat.active = panelSeat
    panelSeat.stateCursor = panelSeat.refCursor = 0
    f.tree = entry.type(entry.props)
    const provider = one(f.tree, n => n.type === 'provider')
    assert.ok(
      one(provider, n => n.type === 'flow'),
      'actual panel owns the React Flow provider'
    )
    const bridge = one(provider, n => n.type?.name === 'FlowApiBridge')
    seat.active = f
    seat.bridge = true
    try {
      bridge.type(bridge.props)
    } finally {
      seat.bridge = false
    }
    return f.tree
  }
  f.render()
  f.workspace = f.states[0]
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
  let started = false,
    resolve
  const done = new Promise(yes => {
    resolve = yes
  })
  const off = f.workspace.subscribe(() => {
    if (f.workspace.busy) started = true
    else if (started) {
      off()
      resolve()
    }
  })
  callback(f.render())
  assert.equal(started, true, 'actual foreground perform must emit busy')
  return done
}
function heldForegroundInspect(f) {
  assert.equal(f.workspace.runId, runId(BETA))
  assert.equal(f.workspace.model.view.state, 'succeeded')
  const held = deferred()
  f.reads.set(runId(BETA), held)
  const done = foreground(f, tree => {
    const retry = action(tree, 'retry-inspect')
    assert.equal(retry.props.disabled, false)
    retry.props.onClick()
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
  const done = foreground(f, () => {
    select.props.onChange({ target: { value: id } })
    const confirmation = findAll(f.render(), node => node.type?.name === 'ConfirmationDialog')[0]
    if (confirmation) {
      f.confirmations.push(confirmation.props.description)
      confirmation.props.onConfirm()
    }
  })
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
      assert.equal(
        locate(f.render()).props.disabled,
        true,
        `FOREGROUND_BUSY_CONTROL_ENABLED: ${label} must expose native disabled while the real foreground inspect is pending`
      )
      assert.equal(f.workspace.runId, runId(BETA))
      assert.deepEqual(f.workspace.editor.exportDefinition(), before.graph)
      assert.deepEqual(f.workspace.model.view, before.view)
      assert.deepEqual([...f.values], before.values, 'disabled Inspect cannot change the Run/draft binding')
      assert.deepEqual(mutations(f), [])
    } finally {
      held.resolve(snapshot(BETA, 8))
      await done
    }
  })
}

for (const mode of ['success', 'failure']) {
  test(`foreground ${mode} settlement restores all four controls and production navigation`, async () => {
    const f = await fixture()
    // Independent ID-scoped draft contents, using the real editor/persistence.
    const node = f.workspace.editor.nodes[0]
    f.workspace.editor.moveNode(node.id, 113.431, -123.084)
    f.workspace.editor.commitLayout()
    const betaDraft = f.values.get(draftKey(BETA)),
      betaGraph = f.workspace.editor.exportDefinition()
    const { held, done } = heldForegroundInspect(f)
    try {
      assertActionability(f, true)
    } finally {
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
    assert.equal(f.workspace.runId, runId(ALPHA))
    assert.deepEqual(f.workspace.model.view, snapshot(ALPHA))
    assert.deepEqual(
      f.calls.filter(([method]) => method === 'loadDefinition'),
      [['loadDefinition', ALPHA]],
      'no selection is silently dropped after settlement'
    )
    assert.equal(f.values.get(draftKey(BETA)), betaDraft)
    assert.equal(f.values.has(draftKey(ALPHA)), false, 'beta edits must not become an alpha draft')
    assert.equal(f.workspace.editor.exportDefinition().id, ALPHA)
    assert.deepEqual(f.workspace.editor.exportDefinition().metadata, { retained: { note: 'Keep all existing document fields' } })
    await navigate(f, BETA)
    assert.deepEqual(f.workspace.editor.exportDefinition(), betaGraph)
    assert.equal(f.workspace.runId, runId(BETA))
    assert.deepEqual(f.workspace.model.view, snapshot(BETA))
    for (const id of [ALPHA, BETA]) assert.deepEqual(JSON.parse(f.values.get(runBindingKey(id))), { blueprintId: id, runId: runId(id) })
    assert.deepEqual(mutations(f), [], 'success/failure/reopen never replay save/start/cancel/decision')
    assert.equal(f.confirmations.length, 0, 'layout-only drafts do not require navigation confirmation')
    assert.equal(f.frames.length, 2, 'existing post-navigation fit scheduling is preserved')
  })
}

for (const outcome of ['success', 'failure']) {
  test(`background inspect ${outcome} alone leaves navigation actionable and late beta result cannot contaminate alpha`, async () => {
    const f = await fixture(),
      held = deferred()
    f.reads.set(runId(BETA), held)
    const read = f.workspace.inspect()
    const observed = read.then(
      () => ({ ok: true }),
      error => ({ ok: false, error })
    )
    assert.equal(f.workspace.busy, false, 'background read is not perform/network-wide busy')
    assert.deepEqual(f.calls, [['inspectRun', runId(BETA)]])
    assertActionability(f, false)
    await navigate(f, ALPHA)
    const graph = f.workspace.editor.exportDefinition(),
      values = [...f.values],
      view = structuredClone(f.workspace.model.view)
    if (outcome === 'failure') held.reject(new BlueprintRemoteError('blueprint/transport-unavailable'))
    else held.resolve(snapshot(BETA, 99))
    const result = await observed
    assert.equal(result.ok, outcome === 'success')
    if (!result.ok) assert.equal(result.error.code, 'blueprint/transport-unavailable')
    assert.equal(f.workspace.busy, false)
    assertActionability(f, false)
    assert.equal(f.workspace.blueprintId, ALPHA)
    assert.equal(f.workspace.runId, runId(ALPHA))
    assert.deepEqual(f.workspace.model.view, view)
    assert.equal(f.workspace.model.connectionState, 'connected')
    assert.deepEqual(f.workspace.editor.exportDefinition(), graph)
    assert.deepEqual([...f.values], values)
    assert.deepEqual(mutations(f), [])
  })
}

test('production Refresh library after inspect settlement dispatches once without rebinding or replay', async () => {
  const f = await fixture(),
    { held, done } = heldForegroundInspect(f)
  held.resolve(snapshot(BETA, 8))
  await done
  assertActionability(f, false)
  const before = { graph: f.workspace.editor.exportDefinition(), view: structuredClone(f.workspace.model.view), values: [...f.values] }
  const refresh = specs[1][1](f.render())
  await foreground(f, () => refresh.props.onClick())
  assert.equal(f.workspace.busy, false)
  assertActionability(f, false)
  assert.deepEqual(f.calls, [['inspectRun', runId(BETA)], ['listDefinitions']])
  assert.equal(f.workspace.runId, runId(BETA))
  assert.equal(f.workspace.blueprintId, BETA)
  assert.deepEqual(f.workspace.editor.exportDefinition(), before.graph)
  assert.deepEqual(f.workspace.model.view, before.view)
  assert.deepEqual([...f.values], before.values)
  assert.deepEqual(mutations(f), [])
})

for (const options of [{ loaded: false }, { boundRuns: false }, { hostAvailable: false }]) {
  test(`inactive controls remain actionable with ${JSON.stringify(options)} and original no-document/no-Run guards remain`, async () => {
    const f = await fixture(options)
    assert.equal(f.workspace.busy, false)
    assertActionability(f, false)
    assert.equal(f.workspace.runId, null)
    assert.equal(f.workspace.model.view, null)
    assert.equal(action(f.tree, 'cancel-run').props.disabled, true)
    assert.equal(action(f.tree, 'retry-inspect').props.disabled, true)
    assert.equal(action(f.tree, 'save-layout').props.disabled, !f.workspace.definition)
    assert.equal(action(f.tree, 'start-run').props.disabled, !f.workspace.definition)
    assert.deepEqual(f.calls, [])
    assert.deepEqual(mutations(f), [])
  })
}

test('foreground library read without a document/Run disables all four controls only until settlement', async () => {
  const f = await fixture({ loaded: false }),
    held = deferred()
  f.listRead = held
  const before = [...f.values]
  const done = foreground(f, tree => specs[1][1](tree).props.onClick())
  try {
    assert.equal(f.workspace.busy, true)
    assertActionability(f, true)
    assert.equal(f.workspace.runId, null)
    assert.equal(f.workspace.definition, null)
    assert.equal(action(f.tree, 'save-layout').props.disabled, true)
  } finally {
    held.resolve()
    await done
  }
  assert.equal(f.workspace.busy, false)
  assertActionability(f, false)
  assert.deepEqual(f.calls, [['listDefinitions']])
  assert.deepEqual([...f.values], before)
  assert.deepEqual(mutations(f), [])
})

test('in-app navigation confirmation cancels without Host calls and rejects stale editor and repeated accept callbacks', async () => {
  const f = await fixture()
  f.workspace.editor.addNode({ id: 'pending-edit', kind: 'input', x: 40, y: 40, inputs: {}, outputs: { value: 'string' } })
  const original = f.workspace.editor,
    before = original.exportDefinition()
  const request = () => specs[0][1](f.render()).props.onChange({ target: { value: ALPHA } })
  const pending = () => one(f.render(), node => node.type?.name === 'ConfirmationDialog')
  request()
  const cancelled = pending()
  assert.equal(cancelled.props.cancelLabel, 'Cancel')
  cancelled.props.onCancel()
  cancelled.props.onConfirm()
  assert.equal(f.workspace.editor, original)
  assert.deepEqual(original.exportDefinition(), before)
  assert.deepEqual(f.calls, [], 'cancel and late accept have zero Host effects')
  request()
  const stale = pending()
  f.workspace.newDraft('Other draft')
  const replacement = f.workspace.editor
  stale.props.onConfirm()
  assert.equal(f.workspace.editor, replacement)
  assert.deepEqual(f.calls, [], 'stale editor cannot navigate')
  await f.workspace.load(BETA)
  f.calls.length = 0
  f.workspace.editor.addNode({ id: 'second-edit', kind: 'input', x: 40, y: 40, inputs: {}, outputs: { value: 'string' } })
  request()
  const accepted = pending()
  const done = foreground(f, () => {
    accepted.props.onConfirm()
    accepted.props.onConfirm()
  })
  await done
  assert.equal(f.workspace.blueprintId, ALPHA)
  assert.deepEqual(
    f.calls.filter(([method]) => method === 'loadDefinition'),
    [['loadDefinition', ALPHA]],
    'repeated accept dispatches exactly once'
  )
})

test('new/delete in-app confirmations preserve the draft on cancel and never invoke native confirm', async () => {
  const f = await fixture()
  f.workspace.editor.addNode({ id: 'dirty-delete', kind: 'input', x: 40, y: 40, inputs: {}, outputs: { value: 'string' } })
  const original = f.workspace.editor
  for (const id of ['new-blueprint', 'delete-blueprint']) {
    action(f.render(), id).props.onClick()
    const dialog = one(f.render(), node => node.type?.name === 'ConfirmationDialog')
    assert.ok(dialog.props.description.length > 10)
    dialog.props.onCancel()
    assert.equal(f.workspace.editor, original)
    assert.deepEqual(f.calls, [])
  }
  assert.deepEqual(f.confirmations, [], 'window.confirm is never used')
})

// C-05 exercises the actual panel decision, independently of any new predicate API.
const confirmationsIn = f => findAll(f.render(), node => node.type?.name === 'ConfirmationDialog')
const requestSwitch = f => specs[0][1](f.render()).props.onChange({ target: { value: ALPHA } })
const requestNew = f => action(f.render(), 'new-blueprint').props.onClick()
for (const operation of ['switch', 'new']) {
  for (const scenario of [
    'saved unchanged',
    'layout only',
    'presentation node title',
    'undo to baseline',
    'reordered object keys',
    'deleted to empty',
    'fresh empty draft',
    'empty renamed draft',
    'restored empty draft',
    'restored layout draft',
    'legacy layout draft'
  ]) {
    test(`C-05 ${operation} bypasses confirmation for ${scenario} while preserving Save dirty/drafts`, async () => {
      const f = await fixture()
      const w = f.workspace
      if (scenario === 'layout only' || scenario === 'restored layout draft' || scenario === 'legacy layout draft') {
        w.editor.moveNode(w.editor.nodes[0].id, 123.25, -40.5)
        w.editor.commitLayout()
        if (scenario === 'legacy layout draft') {
          const draft = JSON.parse(f.values.get(draftKey(BETA)))
          delete draft.definitionJson
          f.values.set(draftKey(BETA), JSON.stringify(draft))
        }
        if (scenario !== 'layout only') await w.load(BETA)
        assert.equal(w.dirty, true, 'layout remains saveable')
      }
      if (scenario === 'presentation node title') {
        w.editor.patchPresentation([w.editor.nodes[0].id], { title: 'Presentation title' })
        assert.equal(w.dirty, true)
      }
      if (scenario === 'undo to baseline') {
        w.editor.renameDefinition('Changed temporarily')
        w.editor.undo()
      }
      if (scenario === 'reordered object keys') {
        const reorder = value =>
          Array.isArray(value)
            ? value.map(reorder)
            : value && typeof value === 'object'
              ? Object.fromEntries(
                  Object.entries(value)
                    .reverse()
                    .map(([k, v]) => [k, reorder(v)])
                )
              : value
        const draft = { documentRevision: w.document.documentRevision, definitionJson: JSON.stringify(reorder(w.definition)), layout: w.editor.exportLayout() }
        f.values.set(draftKey(BETA), JSON.stringify(draft))
        await w.load(BETA)
      }
      if (scenario === 'deleted to empty') {
        w.editor.setSelection(w.editor.nodes.map(node => node.id))
        w.editor.deleteItems(
          w.editor.nodes.map(node => node.id),
          []
        )
        w.editor.renameDefinition('Changed but empty')
        assert.equal(w.editor.nodes.length, 0)
        assert.equal(w.dirty, true)
      }
      if (['fresh empty draft', 'empty renamed draft', 'restored empty draft'].includes(scenario)) {
        w.newDraft('Empty')
        if (scenario !== 'fresh empty draft') w.editor.renameDefinition('Empty renamed')
        if (scenario === 'restored empty draft') {
          const restored = new BlueprintWorkspace(w.host, w.storage)
          await restored.initialize()
          f.states[0] = restored
          f.workspace = restored
          assert.equal(restored.notice.key, 'status.draftRestored')
          assert.equal(restored.dirty, true)
        }
      }
      const valuesBefore = [...f.values]
      f.calls.length = 0
      if (operation === 'switch') {
        requestSwitch(f)
        assert.equal(confirmationsIn(f).length, 0, `${scenario}: no discard dialog`)
        // perform starts synchronously; settle the concrete host read without a timer.
        await new Promise(resolve => {
          if (!f.workspace.busy) return resolve()
          const off = f.workspace.subscribe(() => {
            if (!f.workspace.busy) {
              off()
              resolve()
            }
          })
        })
        assert.equal(f.workspace.blueprintId, ALPHA)
        assert.deepEqual([...f.values], valuesBefore, 'navigation preserves local draft bytes')
      } else {
        requestNew(f)
        assert.equal(confirmationsIn(f).length, 0, `${scenario}: no discard dialog`)
        assert.equal(f.workspace.isNewDraft, true)
      }
      assert.deepEqual(mutations(f), [])
    })
  }
  for (const scenario of ['semantic edit', 'redo semantic edit', 'restored nonempty new draft', 'restored saved semantic draft']) {
    test(`C-05 ${operation} protects ${scenario} and Cancel retains exact editor/draft`, async () => {
      const f = await fixture()
      let w = f.workspace
      if (scenario === 'restored nonempty new draft') {
        w.newDraft('Nonempty restored')
        w.editor.addNode({ id: 'unsaved-node', kind: 'input', x: 0, y: 0, inputs: {}, outputs: { value: 'string' } })
        w = new BlueprintWorkspace(w.host, w.storage)
        await w.initialize()
        f.states[0] = f.workspace = w
        assert.equal(w.notice.key, 'status.draftRestored')
      } else {
        w.editor.renameDefinition('Meaningful change')
        if (scenario === 'redo semantic edit') {
          w.editor.undo()
          w.editor.redo()
        }
        if (scenario === 'restored saved semantic draft') await w.load(BETA)
      }
      const before = { editor: w.editor, definition: w.definition, values: [...f.values] }
      f.calls.length = 0
      ;(operation === 'switch' ? requestSwitch : requestNew)(f)
      const [dialog] = confirmationsIn(f)
      assert.ok(dialog, 'meaningful nonempty edit requires confirmation')
      dialog.props.onCancel()
      dialog.props.onConfirm()
      assert.equal(w.editor, before.editor)
      assert.deepEqual(w.definition, before.definition)
      assert.deepEqual([...f.values], before.values)
      assert.deepEqual(f.calls, [])
    })
  }
}
