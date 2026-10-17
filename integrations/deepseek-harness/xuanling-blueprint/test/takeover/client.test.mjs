// W1 C-08/C-09 contracts preserved, now executable production editor/session/namespace
// oracles. No fake React hooks. Real DOM, pointer, keyboard and DSH factory are
// separate required browser gates, never claimed by this source fixture.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import { GraphEditor } from '../../src/client/features/authoring/logic/graph/graph-editor.ts'
import { BlueprintClientModel } from '../../src/client/features/authoring/logic/run/client-model.ts'
import { BlueprintWorkspace, draftKey, runBindingKey, isEditingTarget } from '../../src/client/features/authoring/logic/workspace/workspace-controller.ts'
import { resolveBlueprintHost } from '../../src/client/adapters/host/remote.ts'
import { flowEdgeEndpoints } from '../../src/client/features/authoring/logic/graph/flow-geometry.ts'
import { applyCanvasNodeChanges, applyCanvasEdgeSelection } from '../../src/client/features/authoring/logic/graph/flow-interactions.ts'
import { apply, inject } from '../../src/client/index.ts'
import { BLUEPRINT_LOCALE, en } from '../../src/client/shared/i18n/locales.ts'
import { decodeDefinition, validateDefinition } from '../../src/definition/index.ts'
import { BLUEPRINT_INVOCATIONS } from '../../src/typert-descriptors.ts'
const definition = {
  schemaVersion: 1,
  id: 'takeover-client',
  name: 'Takeover client fixture',
  resources: { worker: { kind: 'agent', path: 'lib/agents/worker.md' } },
  graph: {
    nodes: [
      { id: 'input', kind: 'input', outputs: { request: 'string' } },
      { id: 'worker', kind: 'agentTask', agentRef: 'worker', inputs: { input: 'string' }, outputs: { result: 'string' } },
      { id: 'output', kind: 'output', inputs: { value: 'string' } }
    ],
    edges: [
      { kind: 'data', from: 'input.request', to: 'worker.input' },
      { kind: 'data', from: 'worker.result', to: 'output.value' }
    ]
  },
  presentation: { nodes: { worker: { x: 120, y: 80 } } },
  metadata: { retained: ['future metadata', { note: 'do not drop' }] }
}
const definitionJson = JSON.stringify(definition)
validateDefinition(decodeDefinition(definitionJson))
// Read-only namespace/Host fixture, not resource, provider or mounted-DSH evidence.
// Derive admission from this fixture's declared executors and validate the wire DTO.
function preflightDocument(document, args) {
  const descriptor = BLUEPRINT_INVOCATIONS.find(item => item.method === 'preflightRun')
  assert.equal(descriptor.parameters[0].codec.create().safeParse(args).success, true)
  assert.equal(args.blueprintId, document.blueprintId)
  assert.equal(args.expectedRevision, document.documentRevision)
  JSON.parse(args.inputJson)
  const saved = decodeDefinition(document.definitionJson)
  validateDefinition(saved)
  const checks = saved.graph.nodes.map(node => {
    assert.ok(['input', 'agentTask', 'humanDecision', 'condition', 'join', 'output'].includes(node.kind))
    assert.ok(node.kind !== 'condition' || node.condition !== undefined)
    assert.ok(node.kind !== 'join' || node.join !== 'any')
    return { code: 'node-executor-ready', status: 'pass', nodeId: node.id }
  })
  checks.push({ code: 'host-approval-unverified', status: 'info' })
  const report = {
    blueprintId: document.blueprintId,
    documentRevision: document.documentRevision,
    semanticRevision: document.semanticRevision,
    canStart: !checks.some(check => check.status === 'block'),
    checks
  }
  const parsed = descriptor.result.create().safeParse(report)
  assert.equal(parsed.success, true, 'fixture preflight uses the current strict public DTO')
  return parsed.data
}
function fixture(options = {}) {
  const calls = []
  let revision = 1
  let json = definitionJson
  let snapshot = { runId: 'fixture-run', state: 'running', seq: 0, definitionRevision: 'semantic-1', attempts: [], logTail: [] }
  const doc = () => ({
    blueprintId: definition.id,
    definitionJson: json,
    documentRevision: `document-${revision}`,
    semanticRevision: 'semantic-1',
    layoutRevision: `layout-${revision}`
  })
  const keys = {
    loadDefinition: ['blueprintId'],
    saveDefinition: ['blueprintId', 'definitionJson', 'expectedRevision'],
    validate: ['definitionJson'],
    preflightRun: ['blueprintId', 'expectedRevision', 'inputJson'],
    startRun: ['blueprintId', 'expectedRevision', 'inputJson', 'requestId'],
    inspectRun: ['runId'],
    cancelRun: ['runId'],
    decide: ['runId', 'decisionId', 'action']
  }
  const values = {
    listDefinitions: () => ({
      definitions: [{ blueprintId: definition.id, name: definition.name, documentRevision: doc().documentRevision, semanticRevision: 'semantic-1' }]
    }),
    loadDefinition: () => doc(),
    saveDefinition: args => {
      validateDefinition(decodeDefinition(args.definitionJson))
      assert.equal(args.expectedRevision, doc().documentRevision)
      json = args.definitionJson
      revision++
      return doc()
    },
    validate: args => {
      validateDefinition(decodeDefinition(args.definitionJson))
      return { ok: true, semanticRevision: 'semantic-1' }
    },
    preflightRun: args => preflightDocument(doc(), args),
    startRun: args => {
      assert.equal(args.blueprintId, definition.id)
      assert.equal(args.expectedRevision, doc().documentRevision)
      assert.ok(args.requestId)
      return { runId: 'fixture-run', state: 'running', semanticRevision: 'semantic-1', replayed: false }
    },
    inspectRun: () => structuredClone(snapshot),
    cancelRun: () => {
      snapshot = { ...snapshot, state: 'cancelled', seq: snapshot.seq + 1 }
      return { runId: 'fixture-run', state: snapshot.state }
    },
    decide: args => ({ runId: args.runId, decisionId: args.decisionId, state: 'running', applied: true })
  }
  const blueprint = Object.fromEntries(
    Object.entries(values).map(([method, value]) => [
      method,
      async function (args) {
        assert.equal(this, blueprint, 'namespace receiver must be preserved')
        if (method === 'listDefinitions') assert.equal(args, undefined)
        else assert.deepEqual(Object.keys(args).sort(), keys[method].sort(), `${method}: no browser locators or inline start definition`)
        calls.push([method, structuredClone(args)])
        const error = options.error?.(method, args)
        return error ? { ok: false, error: { code: error } } : { ok: true, value: value(args) }
      }
    ])
  )
  const host = resolveBlueprintHost({ get: key => (key === 'remote.blueprint' ? blueprint : undefined) })
  const workspace = new BlueprintWorkspace(host, options.storage)
  return {
    blueprint,
    calls,
    host,
    workspace,
    setSnapshot: value => {
      snapshot = value
    }
  }
}
async function loaded(options) {
  const f = fixture(options)
  await f.workspace.initialize()
  await f.workspace.load(definition.id)
  f.calls.length = 0
  return f
}

test('C-09 drag-undo: one completed drag restores the pre-gesture coordinates', () => {
  const editor = GraphEditor.fromDefinition(definition)
  const before = editor.exportLayout().nodes.worker
  editor.moveNode('worker', 230, 160)
  editor.moveNode('worker', 310, 220)
  editor.commitLayout()
  assert.equal(editor.undo(), true)
  assert.deepEqual(editor.exportLayout().nodes.worker, before, 'DRAG_UNDO_COORDINATES')
  assert.equal(editor.canUndo, false)
  assert.equal(editor.redo(), true)
  assert.deepEqual(editor.exportLayout().nodes.worker, { x: 310, y: 220 })
})
test('C-09 import layout: production initialization keeps restored coordinates instead of undoing them', async () => {
  const layout = { nodes: { worker: { x: 640, y: 360 } }, groups: [] }
  const reads = []
  const f = await loaded({
    storage: {
      getItem(key) {
        reads.push(key)
        return JSON.stringify({ documentRevision: 'document-1', layout })
      },
      setItem() {
        assert.fail('initialization must not rewrite draft')
      }
    }
  })
  assert.deepEqual(reads, ['xuanling-blueprint:new-draft', draftKey(definition.id), runBindingKey(definition.id)])
  assert.deepEqual(f.workspace.editor.exportLayout().nodes.worker, layout.nodes.worker, 'LAYOUT_INITIALIZATION_PRESERVED')
  assert.equal(f.workspace.editor.canUndo, false)
})
test('C-08 client entry: a real remote.blueprint namespace is recognized as the host link', async t => {
  const f = fixture()
  const requested = []
  let registered
  let mounts = 0
  const context = new Context()
  t.after(() => context.fiber.dispose())
  // Execute the installed locale closure unchanged. Settings UI is not mounted;
  // its dependencies throw on use rather than faking settings behavior.
  const require = createRequire(import.meta.url)
  const registrations = []
  const sandbox = { console, __ModuleLoader__: { load: registration => registrations.push(registration) } }
  sandbox.window = sandbox
  sandbox.self = sandbox
  const localePath = require.resolve('@deepseek-ai/dsh-client-locale/client')
  runInNewContext(readFileSync(localePath, 'utf8'), sandbox, { filename: localePath })
  assert.equal(registrations.length, 1)
  const installedLocale = registrations[0].factory(id => {
    if (id === 'react' || id === 'react/jsx-runtime') return require(id)
    assert.ok(['@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-store'].includes(id), `UNEXPECTED_LOCALE_DEPENDENCY:${id}`)
    return new Proxy(
      {},
      {
        get: (_target, key) => {
          throw new Error(`UNMOUNTED_LOCALE_SETTINGS_DEPENDENCY:${id}:${String(key)}`)
        }
      }
    )
  })
  const locale = new installedLocale.LocaleRuntime(context, undefined, { languages: ['en'], preference: null })
  context.provide('locale', locale)
  const rows = new Set()
  let slotDisposals = 0
  context.provide('slots', {
    inject(_key, register) {
      const dispose = register()
      let disposed = false
      assert.equal(typeof dispose, 'function', 'slot registration returns its disposer')
      return () => {
        if (disposed) return
        disposed = true
        dispose()
        slotDisposals += 1
      }
    },
    register(options, panel) {
      const row = { options, panel }
      rows.add(row)
      if (options.name === 'main') registered = panel
      return () => {
        rows.delete(row)
        if (registered === panel) registered = undefined
      }
    }
  })
  // Namespace fixture only: the separate native test runs installed Gateway
  // factories. Real Cordis here executes the parent + namespace-ready child.
  context.provide('remote', {
    async $mount(contribution) {
      assert.equal(contribution.package, '@xuanling-rs/xuanling-dsh-blueprint')
      mounts += 1
      const withdraw = context.provide('remote.blueprint', f.blueprint)
      return async () => {
        await withdraw()
      }
    }
  })
  const fiber = context.plugin({ inject, apply })
  await fiber
  assert.equal(rows.size, 2, 'locale-ready fixture mounts both seats')
  assert.equal(locale.bind(BLUEPRINT_LOCALE)('panel.label'), en['panel.label'], 'entry registers its dictionaries on the real installed locale')
  assert.equal(typeof registered, 'function')
  assert.equal(mounts, 1)
  assert.deepEqual(f.calls, [], 'entry discovery never starts a run')
  const host = resolveBlueprintHost({
    get(key) {
      requested.push(key)
      return context.get(key)
    }
  })
  assert.ok(host, 'REMOTE_BLUEPRINT_NAMESPACE')
  assert.deepEqual(requested, ['remote.blueprint'])
  await host.listDefinitions()
  assert.equal(f.calls[0][0], 'listDefinitions')
  const callsBeforeDispose = structuredClone(f.calls)
  await fiber.dispose()
  assert.equal(rows.size, 0, 'entry disposal releases both seats')
  assert.equal(slotDisposals, 2, 'slot callback disposers are actually invoked')
  assert.equal(registered, undefined)
  assert.equal(context.get('remote.blueprint'), undefined, 'entry disposal withdraws its namespace')
  assert.equal(locale.bind(BLUEPRINT_LOCALE)('panel.label'), 'panel.label', 'entry disposal releases its dictionaries')
  await fiber.dispose()
  assert.equal(slotDisposals, 2, 'repeated disposal does not replay slot cleanup')
  assert.deepEqual(f.calls, callsBeforeDispose, 'cleanup never sends a business command')
})
test('C-08 client entry: root-remote methods must never be selected instead of remote.blueprint', async () => {
  const f = fixture()
  const rootReads = []
  const requested = []
  const root = new Proxy(
    { blueprint: f.blueprint },
    {
      get(target, key) {
        rootReads.push(key)
        return Reflect.get(target, key)
      }
    }
  )
  const host = resolveBlueprintHost({
    get(key) {
      requested.push(key)
      return key === 'remote.blueprint' ? f.blueprint : root
    }
  })
  await host.inspectRun('fixture-run')
  await host.startRun(definition.id, 'document-1', '{}', 'source-request')
  assert.deepEqual(rootReads, [], 'REMOTE_ROOT_NOT_SELECTED')
  assert.deepEqual(requested, ['remote.blueprint'])
  assert.equal(f.calls.length, 2)
})
test('C-08 valid definition and host methods expose executable save-before-Run, not local run fabrication', async () => {
  const f = await loaded()
  f.workspace.editor.moveNode('worker', 500, 300)
  f.workspace.editor.commitLayout()
  await f.workspace.run()
  assert.deepEqual(
    f.calls.map(([method]) => method),
    ['saveDefinition', 'preflightRun', 'startRun', 'inspectRun']
  )
  const saved = decodeDefinition(f.calls[0][1].definitionJson)
  assert.deepEqual(saved.graph, definition.graph)
  assert.deepEqual(saved.resources, definition.resources)
  assert.deepEqual(saved.metadata, definition.metadata)
  assert.deepEqual(saved.presentation.nodes.worker, { x: 500, y: 300 })
  assert.deepEqual(f.calls[1][1], { blueprintId: definition.id, expectedRevision: 'document-2', inputJson: f.calls[2][1].inputJson })
  assert.equal(f.calls[2][1].expectedRevision, 'document-2')
  assert.equal(f.workspace.model.view.runId, 'fixture-run')
  assert.equal(f.workspace.dirty, false)
})
test('control: production client model adopts snapshots and resyncs without replaying commands', async () => {
  const f = fixture()
  const model = new BlueprintClientModel()
  await model.resync(f.host, 'fixture-run')
  assert.equal(model.view.runId, 'fixture-run')
  assert.equal(model.connectionState, 'connected')
  assert.deepEqual(f.calls, [['inspectRun', { runId: 'fixture-run' }]])
  model.markDisconnected()
  assert.equal(model.connectionState, 'stale')
})
test('C-08 failed CAS preserves draft and never starts; retry inspect is read-only', async () => {
  const f = await loaded({ error: method => (method === 'saveDefinition' ? 'blueprint/revision-conflict' : undefined) })
  f.workspace.editor.moveNode('worker', 700, 450)
  f.workspace.editor.commitLayout()
  await assert.rejects(f.workspace.run(), { code: 'blueprint/revision-conflict' })
  assert.equal(f.workspace.document.documentRevision, 'document-1')
  assert.deepEqual(f.workspace.editor.exportLayout().nodes.worker, { x: 700, y: 450 })
  assert.equal(
    f.calls.some(([method]) => method === 'startRun'),
    false
  )
  f.workspace.runId = 'fixture-run'
  await f.workspace.inspect()
  f.workspace.model.markDisconnected()
  await f.workspace.inspect()
  assert.deepEqual(
    f.calls.map(([method]) => method),
    ['saveDefinition', 'inspectRun', 'inspectRun']
  )
})
test('C-09 drafts are ID-scoped, outdated layout never overwrites newer host document', async () => {
  const keys = []
  const f = await loaded({
    storage: {
      getItem(key) {
        keys.push(key)
        return JSON.stringify({ documentRevision: 'old', layout: { nodes: { worker: { x: 999, y: 999 } } } })
      },
      setItem() {}
    }
  })
  assert.deepEqual(f.workspace.editor.exportLayout().nodes.worker, { x: 120, y: 80 })
  assert.match(f.workspace.status, /not applied/)
  assert.notEqual(draftKey('a/b'), draftKey('a%2Fb'))
  assert.deepEqual(keys, ['xuanling-blueprint:new-draft', draftKey(definition.id), runBindingKey(definition.id)])
})
test('C-09 delete/undo and resource/node options keep existing semantic and metadata fields', () => {
  const e = GraphEditor.fromDefinition(definition)
  e.updateNode('worker', { skillRefs: [], toolsetRefs: [] })
  e.updateResource('worker', { ...definition.resources.worker })
  e.toggleSelect('worker', false)
  e.removeSelected()
  assert.equal(e.nodes.length, 2)
  assert.equal(e.edges.length, 0)
  e.undo()
  const exported = e.exportDefinition()
  validateDefinition(decodeDefinition(JSON.stringify(exported)))
  assert.equal(exported.graph.nodes[1].agentRef, 'worker')
  assert.deepEqual(exported.metadata, definition.metadata)
})
test('C-09 named ports reject direction/type/control mixing, duplicate edges and data cycles without history side effects', () => {
  const e = GraphEditor.fromDefinition(definition)
  const from = { nodeId: 'input', port: 'request', direction: 'out', type: 'string' }
  const to = { nodeId: 'worker', port: 'input', direction: 'in', type: 'string' }
  for (const pair of [
    [from, { ...to, type: 'number' }],
    [{ ...from, direction: 'in' }, to],
    [{ ...from, kind: 'control' }, to],
    [from, to]
  ])
    assert.equal(e.connect(...pair).ok, false)
  assert.equal(e.canUndo, false)
  assert.equal(e.edges.length, 2)
  e.updateNode('input', { inputs: { back: 'string' } })
  const before = e.edges.length
  assert.equal(
    e.connect({ nodeId: 'worker', port: 'result', direction: 'out', type: 'string' }, { nodeId: 'input', port: 'back', direction: 'in', type: 'string' })
      .reason,
    'data-cycle'
  )
  assert.equal(e.edges.length, before)
})
test('C-09 keyboard contract never hijacks input, textarea, select or contenteditable', () => {
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(isEditingTarget({ tagName }), true)
  assert.equal(isEditingTarget({ tagName: 'DIV', isContentEditable: true }), true)
  assert.equal(isEditingTarget({ tagName: 'DIV' }), false)
})
test('C-08 inspect failure marks stale without erasing facts; decision retries preserve decisionId', async () => {
  let failed = false
  const f = await loaded({ error: method => (method === 'decide' && !failed ? ((failed = true), 'blueprint/transport-unavailable') : undefined) })
  f.workspace.runId = 'fixture-run'
  f.setSnapshot({
    runId: 'fixture-run',
    state: 'waiting_input',
    seq: 4,
    definitionRevision: 'semantic-1',
    attempts: [{ nodeId: 'worker', attempt: 1, state: 'waiting_input' }],
    logTail: []
  })
  await f.workspace.inspect()
  await assert.rejects(f.workspace.decide('approve'))
  await f.workspace.decide('approve')
  const decisions = f.calls.filter(([method]) => method === 'decide')
  assert.equal(decisions[0][1].decisionId, decisions[1][1].decisionId)
  await assert.rejects(f.workspace.model.resync({ inspectRun: () => Promise.reject(new Error('network')) }, 'fixture-run'))
  assert.equal(f.workspace.model.connectionState, 'stale')
  assert.equal(f.workspace.model.view.state, 'waiting_input')
})

test('C-09 real canvas edge projection preserves the complete legal dotted port name', () => {
  const d = {
    schemaVersion: 1,
    id: 'dotted-ports',
    name: 'Dotted ports',
    resources: {},
    graph: {
      nodes: [
        { id: 'input', kind: 'input', outputs: { 'request.text': 'string' } },
        { id: 'output', kind: 'output', inputs: { 'answer.text': 'string' } }
      ],
      edges: [{ kind: 'data', from: 'input.request.text', to: 'output.answer.text' }]
    }
  }
  validateDefinition(decodeDefinition(JSON.stringify(d)))
  const edge = GraphEditor.fromDefinition(d).edges[0]
  assert.deepEqual(
    flowEdgeEndpoints(edge),
    { source: 'input', target: 'output', sourceHandle: 'data:request.text', targetHandle: 'data:answer.text' },
    'FIRST_DOT_ENDPOINT_HANDLE'
  )
})

// C-08 main review reproductions: real workspace + production namespace adapter,
// legal decoder-validated documents; transport fixture is not live DSH evidence.
function bindingFixture(
  storage = (() => {
    const values = new Map()
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  })()
) {
  const calls = []
  const documents = new Map(
    ['A', 'B'].map(id => {
      const d = { ...structuredClone(definition), id, name: `Package ${id}` }
      validateDefinition(decodeDefinition(JSON.stringify(d)))
      return [
        id,
        { blueprintId: id, definitionJson: JSON.stringify(d), documentRevision: `doc-${id}-1`, semanticRevision: `sem-${id}`, layoutRevision: `layout-${id}` }
      ]
    })
  )
  let inspect = async runId => ({
    runId,
    state: 'waiting_input',
    seq: 4,
    definitionRevision: `sem-${runId.slice(4)}`,
    attempts: [{ nodeId: 'worker', attempt: 1, state: 'waiting_input' }],
    logTail: [{ seq: 4, kind: 'waiting' }]
  })
  const methods = {
    listDefinitions: () => ({
      definitions: [...documents.values()].map(d => ({
        blueprintId: d.blueprintId,
        name: d.blueprintId,
        documentRevision: d.documentRevision,
        semanticRevision: d.semanticRevision
      }))
    }),
    loadDefinition: args => documents.get(args.blueprintId),
    saveDefinition: args => {
      assert.equal(args.expectedRevision, documents.get(args.blueprintId).documentRevision)
      validateDefinition(decodeDefinition(args.definitionJson))
      const doc = {
        ...documents.get(args.blueprintId),
        definitionJson: args.definitionJson,
        documentRevision: `${documents.get(args.blueprintId).documentRevision}-saved`
      }
      documents.set(args.blueprintId, doc)
      return doc
    },
    validate: args => {
      validateDefinition(decodeDefinition(args.definitionJson))
      return { ok: true, semanticRevision: 'validated' }
    },
    preflightRun: args => preflightDocument(documents.get(args.blueprintId), args),
    startRun: args => ({ runId: `run-${args.blueprintId}`, state: 'running', semanticRevision: `sem-${args.blueprintId}`, replayed: false }),
    inspectRun: args => inspect(args.runId),
    cancelRun: args => ({ runId: args.runId, state: 'cancelled' }),
    decide: args => ({ runId: args.runId, decisionId: args.decisionId, state: 'running', applied: true })
  }
  const blueprint = Object.fromEntries(
    Object.entries(methods).map(([method, value]) => [
      method,
      async function (args) {
        assert.equal(this, blueprint)
        calls.push([method, structuredClone(args)])
        return { ok: true, value: await value(args) }
      }
    ])
  )
  const host = resolveBlueprintHost({ get: key => (key === 'remote.blueprint' ? blueprint : undefined) })
  return {
    host,
    storage,
    calls,
    workspace: new BlueprintWorkspace(host, storage),
    setInspect: fn => {
      inspect = fn
    }
  }
}
async function bindingStarted() {
  const f = bindingFixture()
  await f.workspace.initialize()
  await f.workspace.load('A')
  await f.workspace.run()
  return f
}

test('C-08 blueprint switch clears previous run, overlay and command IDs; switch back inspects only its own binding', async () => {
  const f = await bindingStarted()
  await f.workspace.decide('approve')
  const previousDecision = f.calls.find(([method]) => method === 'decide')[1].decisionId
  await f.workspace.load('B')
  assert.equal(f.workspace.runId, null, 'RUN_ID_LEAKS_ACROSS_BLUEPRINT_SWITCH')
  assert.equal(f.workspace.model.view, null, 'RUN_OVERLAY_LEAKS_ACROSS_BLUEPRINT_SWITCH')
  const before = f.calls.length
  await f.workspace.cancel()
  await f.workspace.inspect()
  assert.equal(f.calls.length, before, 'UNBOUND_PACKAGE_MUST_NOT_DISPATCH_TO_PREVIOUS_RUN')
  f.calls.length = 0
  await f.workspace.load('A')
  assert.equal(f.workspace.runId, 'run-A')
  assert.equal(f.workspace.model.view.runId, 'run-A')
  assert.deepEqual(
    f.calls.map(([method]) => method),
    ['loadDefinition', 'validate', 'inspectRun']
  )
  await f.workspace.decide('approve')
  assert.notEqual(f.calls.find(([method]) => method === 'decide')[1].decisionId, previousDecision, 'SWITCH_CLEARS_COMMAND_ID_STATE')
})

test('C-08 refresh re-fetches the ID-scoped recent run by inspect only, never replaying commands', async () => {
  const f = await bindingStarted()
  f.calls.length = 0
  const restored = new BlueprintWorkspace(f.host, f.storage)
  await restored.initialize()
  await restored.load('A')
  assert.equal(restored.runId, 'run-A', 'REFRESH_LOSES_BOUND_RUN_ID')
  assert.equal(restored.model.view.runId, 'run-A', 'REFRESH_DOES_NOT_REFETCH_DURABLE_SNAPSHOT')
  assert.deepEqual(
    f.calls.map(([method]) => method),
    ['listDefinitions', 'loadDefinition', 'validate', 'inspectRun'],
    'REFRESH_IS_A_READ_NOT_COMMAND_REPLAY'
  )
  await restored.load('B')
  assert.equal(restored.runId, null)
  assert.equal(restored.model.view, null)
})

test('C-08 a delayed inspect success or failure cannot overwrite the later blueprint or its connection state', async () => {
  for (const failed of [false, true]) {
    const f = await bindingStarted()
    let release
    const deferred = new Promise((resolve, reject) => {
      release = failed ? reject : resolve
    })
    f.setInspect(() => deferred)
    const pending = f.workspace.inspect()
    await f.workspace.load('B')
    if (failed) release(new Error('delayed transport failure'))
    else release({ runId: 'run-A', state: 'succeeded', seq: 20, definitionRevision: 'sem-A', attempts: [], logTail: [] })
    await pending.catch(error => {
      assert.equal(failed, true)
      assert.equal(error.message, 'delayed transport failure')
    })
    assert.equal(f.workspace.blueprintId, 'B')
    assert.equal(f.workspace.runId, null)
    assert.equal(f.workspace.model.view, null, 'STALE_INSPECT_MUST_NOT_REPLACE_NEW_PACKAGE_OVERLAY')
    assert.equal(f.workspace.model.connectionState, 'connected', 'STALE_FAILURE_MUST_NOT_MARK_NEW_PACKAGE_DISCONNECTED')
  }
})

test('C-08 local document drafts use the canonical host validator before adoption; rejected drafts leave the entire host graph intact', async () => {
  const values = new Map()
  const bad = structuredClone(definition)
  bad.graph.edges[0].to = 'missing.port'
  values.set(
    draftKey(definition.id),
    JSON.stringify({ documentRevision: 'document-1', definitionJson: JSON.stringify(bad), layout: { nodes: { worker: { x: 999, y: 999 } }, groups: [] } })
  )
  const f = await loaded({
    storage: { getItem: key => values.get(key) ?? null, setItem: () => assert.fail('rejected restoration must not rewrite the draft') },
    error: method => (method === 'validate' ? 'blueprint/invalid-definition' : undefined)
  })
  assert.deepEqual(f.workspace.editor.exportDefinition(), GraphEditor.fromDefinition(definition).exportDefinition())
  assert.equal(f.workspace.editor.canUndo, false)
  assert.match(f.workspace.status, /Invalid local draft ignored/)
  // loaded() resets call capture; explicitly reopen to observe boundary ordering.
  await f.workspace.load(definition.id)
  assert.deepEqual(
    f.calls.map(([method]) => method),
    ['loadDefinition', 'validate']
  )
  assert.equal(f.calls[1][1].definitionJson, JSON.stringify(bad))
})
test('C-08 host-validated drafts still require the loaded ID/schema binding and retain all existing fields', async () => {
  for (const patch of [{ id: 'other-package' }, { schemaVersion: 2 }]) {
    const candidate = { ...definition, ...patch }
    // The ID/schema mismatch is a browser binding check even if a transport
    // erroneously reports validation success; it is not a copied graph schema.
    const host = fixture().host
    const fakeAccepted = { ...host, validate: async () => ({ ok: true, semanticRevision: 'accepted' }) }
    const w = new BlueprintWorkspace(fakeAccepted, {
      getItem: key =>
        key === draftKey(definition.id)
          ? JSON.stringify({ documentRevision: 'document-1', definitionJson: JSON.stringify(candidate), layout: { nodes: { worker: { x: 888, y: 777 } } } })
          : null,
      setItem: () => assert.fail('must not rewrite invalid draft')
    })
    await w.initialize()
    await w.load(definition.id)
    assert.deepEqual(w.editor.exportDefinition(), GraphEditor.fromDefinition(definition).exportDefinition())
    assert.equal(w.editor.canUndo, false)
  }
  const candidate = structuredClone(definition)
  candidate.graph.nodes[1].toolsetRefs = []
  candidate.metadata.retainedDraft = ['exact', 1]
  candidate.presentation.nodes.worker = { x: 532, y: 215 }
  validateDefinition(decodeDefinition(JSON.stringify(candidate)))
  const f = await loaded({
    storage: {
      getItem: key =>
        key === draftKey(definition.id)
          ? JSON.stringify({ documentRevision: 'document-1', definitionJson: JSON.stringify(candidate), layout: { nodes: candidate.presentation.nodes } })
          : null,
      setItem: () => assert.fail('restore is not a write')
    }
  })
  assert.deepEqual(f.workspace.editor.exportDefinition(), GraphEditor.fromDefinition(candidate).exportDefinition())
  assert.equal(f.workspace.editor.canUndo, false)
})

test('C-08 a pending old action failure cannot replace status or mark a later blueprint stale', async () => {
  const f = await bindingStarted()
  let reject
  const pending = f.workspace.perform(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail
      })
  )
  await f.workspace.load('B')
  const status = f.workspace.status
  reject(new Error('old run action failed'))
  await pending
  assert.equal(f.workspace.status, status, 'OLD_ACTION_STATUS_MUST_NOT_LEAK_INTO_NEW_BLUEPRINT')
  assert.equal(f.workspace.model.connectionState, 'connected')
  assert.equal(f.workspace.model.view, null)
  assert.equal(f.workspace.busy, false)
})

test('C-09 controlled React Flow node selection deltas support multi-select/deselect without definition or Undo changes', () => {
  const e = GraphEditor.fromDefinition(definition)
  const before = e.exportDefinition()
  applyCanvasNodeChanges(e, [
    { type: 'select', id: 'input', selected: true },
    { type: 'select', id: 'worker', selected: true }
  ])
  assert.deepEqual([...e.selection], ['input', 'worker'], 'CONTROLLED_NODE_SELECTION_MUST_APPLY_DELTAS')
  applyCanvasNodeChanges(e, [{ type: 'select', id: 'input', selected: false }])
  assert.deepEqual([...e.selection], ['worker'])
  assert.deepEqual(e.exportDefinition(), before)
  assert.equal(e.canUndo, false, 'selection is not a document edit')
  e.deleteItems([...e.selection], [])
  assert.equal(
    e.nodes.some(node => node.id === 'worker'),
    false
  )
  assert.equal(e.undo(), true)
  assert.deepEqual(e.exportDefinition(), before)
})

test('C-09 controlled React Flow edge selection deltas drive Delete/Undo without selecting other edges or making selection durable', () => {
  const e = GraphEditor.fromDefinition(definition)
  const before = e.exportDefinition()
  const [first, second] = e.edges
  let selected = applyCanvasEdgeSelection([], [{ type: 'select', id: first.id, selected: true }])
  assert.deepEqual(selected, [first.id], 'CONTROLLED_EDGE_SELECTION_MUST_APPLY_DELTAS')
  selected = applyCanvasEdgeSelection(selected, [
    { type: 'select', id: second.id, selected: true },
    { type: 'select', id: first.id, selected: false }
  ])
  assert.deepEqual(selected, [second.id])
  assert.equal(e.canUndo, false)
  e.deleteItems([], selected)
  assert.deepEqual(
    e.edges.map(edge => edge.id),
    [first.id]
  )
  assert.equal(e.undo(), true)
  assert.deepEqual(e.exportDefinition(), before)
})

// C-08 bounded local-error regression: legal loaded document and a real
// namespace inspect of an already succeeded Run. This is source evidence,
// not mounted-browser/provider evidence; no parser text or input is displayed.
async function connectedSucceededWorkspace(options) {
  const f = await loaded(options)
  f.workspace.runId = 'fixture-run'
  f.setSnapshot({
    runId: 'fixture-run',
    state: 'succeeded',
    seq: 7,
    definitionRevision: 'semantic-1',
    attempts: [{ nodeId: 'worker', attemptId: 'previous-attempt', attempt: 1, state: 'succeeded' }],
    logTail: [{ seq: 7, kind: 'completed' }]
  })
  await f.workspace.inspect()
  assert.equal(f.workspace.model.connectionState, 'connected', 'fixture must have an authoritative connected Run')
  assert.equal(f.workspace.model.view.state, 'succeeded', 'fixture must inspect the successful terminal precondition')
  assert.deepEqual(f.calls, [['inspectRun', { runId: 'fixture-run' }]])
  f.calls.length = 0
  return f
}

test('C-08 local malformed Run input rejects with existing definition-invalid/input issue before any host mutation', async () => {
  const f = await connectedSucceededWorkspace()
  f.workspace.inputJson = '{'
  await assert.rejects(f.workspace.run(), error => {
    assert.equal(error.code, 'blueprint/definition-invalid', 'LOCAL_INPUT_MUST_BE_TYPED_NOT_TRANSPORT')
    assert.deepEqual(error.details, { issues: 'invalid-input-json' })
    assert.equal(error.message.includes('Unexpected'), false, 'raw JSON parser diagnostics are not the public failure')
    return true
  })
  assert.deepEqual(f.calls, [], 'INVALID_INPUT_MUST_NOT_SAVE_START_OR_REPLAY_COMMANDS')
  assert.equal(f.workspace.model.connectionState, 'connected')
})

test('C-08 perform malformed input keeps the full inspected succeeded Run connected and shows an honest input failure', async () => {
  const values = new Map()
  const f = await connectedSucceededWorkspace({ storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } })
  f.workspace.editor.moveNode('worker', 640, 410)
  f.workspace.editor.commitLayout()
  const before = {
    view: structuredClone(f.workspace.model.view),
    document: structuredClone(f.workspace.document),
    draft: values.get(draftKey(definition.id)),
    graph: f.workspace.editor.exportDefinition(),
    resyncCount: f.workspace.model.resyncCount
  }
  f.workspace.inputJson = '{'
  await f.workspace.perform(() => f.workspace.run())
  assert.deepEqual(f.calls, [], 'INVALID_INPUT_MUST_NOT_SAVE_START_INSPECT_OR_REPLAY_COMMANDS')
  assert.equal(f.workspace.model.connectionState, 'connected', 'LOCAL_INPUT_MUST_NOT_MARK_UNRELATED_RUN_NETWORK_STALE')
  assert.match(f.workspace.status, /^blueprint\/definition-invalid.*invalid-input-json$/, 'VISIBLE_FAILURE_MUST_IDENTIFY_INPUT_NOT_TRANSPORT')
  assert.deepEqual(f.workspace.model.view, before.view, 'FULL_INSPECTED_SNAPSHOT_MUST_REMAIN_UNCHANGED')
  assert.equal(f.workspace.runId, 'fixture-run')
  assert.deepEqual(f.workspace.document, before.document)
  assert.deepEqual(f.workspace.editor.exportDefinition(), before.graph)
  assert.equal(values.get(draftKey(definition.id)), before.draft)
  assert.equal(f.workspace.dirty, true)
  assert.equal(f.workspace.model.resyncCount, before.resyncCount)
  assert.equal(f.workspace.inputJson, '{', 'failed input remains editable')
  assert.equal(f.workspace.busy, false)
})

for (const code of ['blueprint/revision-conflict', 'blueprint/definition-invalid']) {
  test(`C-08 perform ${code} preserves the connected authoritative Run and CAS draft without starting`, async () => {
    const values = new Map()
    const f = await connectedSucceededWorkspace({
      error: method => (method === 'saveDefinition' ? code : undefined),
      storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
    })
    f.workspace.editor.moveNode('worker', 720, 480)
    f.workspace.editor.commitLayout()
    const before = {
      view: structuredClone(f.workspace.model.view),
      document: structuredClone(f.workspace.document),
      graph: f.workspace.editor.exportDefinition(),
      draft: values.get(draftKey(definition.id))
    }
    await f.workspace.perform(() => f.workspace.run())
    assert.equal(f.workspace.status, code, 'typed host domain rejection must remain visible')
    assert.deepEqual(
      f.calls.map(([method]) => method),
      ['saveDefinition']
    )
    assert.equal(f.calls[0][1].expectedRevision, before.document.documentRevision)
    assert.equal(f.workspace.model.connectionState, 'connected', 'DOMAIN_REJECTION_IS_NOT_A_TRANSPORT_DROP')
    assert.deepEqual(f.workspace.model.view, before.view)
    assert.equal(f.workspace.runId, 'fixture-run')
    assert.deepEqual(f.workspace.document, before.document)
    assert.deepEqual(f.workspace.editor.exportDefinition(), before.graph)
    assert.equal(values.get(draftKey(definition.id)), before.draft)
    assert.equal(f.workspace.dirty, true)
    assert.equal(f.workspace.busy, false)
  })
}

for (const typed of [false, true]) {
  test(`C-08 perform ${typed ? 'typed' : 'rejected namespace'} transport failure still marks stale without erasing succeeded facts or drafts`, async () => {
    const f = await connectedSucceededWorkspace({
      error: method => {
        if (method !== 'saveDefinition') return
        if (typed) return 'blueprint/transport-unavailable'
        throw new Error('controlled transport failure; do not display this raw detail')
      }
    })
    f.workspace.editor.moveNode('worker', 750, 500)
    f.workspace.editor.commitLayout()
    const before = {
      view: structuredClone(f.workspace.model.view),
      graph: f.workspace.editor.exportDefinition(),
      document: structuredClone(f.workspace.document)
    }
    await f.workspace.perform(() => f.workspace.run())
    assert.equal(f.workspace.status, 'blueprint/transport-unavailable')
    assert.equal(f.workspace.model.connectionState, 'stale', 'REAL_TRANSPORT_FAILURE_MUST_KEEP_STALE_GATE')
    assert.deepEqual(f.workspace.model.view, before.view)
    assert.deepEqual(f.workspace.editor.exportDefinition(), before.graph)
    assert.deepEqual(f.workspace.document, before.document)
    assert.equal(f.workspace.dirty, true)
    assert.deepEqual(
      f.calls.map(([method]) => method),
      ['saveDefinition']
    )
    assert.equal(f.workspace.busy, false)
  })
}

test('C-08 perform a real inspect transport failure remains stale and preserves the entire previous succeeded snapshot', async () => {
  let disconnected = false
  const f = await connectedSucceededWorkspace({ error: method => (disconnected && method === 'inspectRun' ? 'blueprint/transport-unavailable' : undefined) })
  const before = structuredClone(f.workspace.model.view)
  disconnected = true
  await f.workspace.perform(() => f.workspace.inspect())
  assert.deepEqual(f.calls, [['inspectRun', { runId: 'fixture-run' }]])
  assert.equal(f.workspace.status, 'blueprint/transport-unavailable')
  assert.equal(f.workspace.model.connectionState, 'stale')
  assert.deepEqual(f.workspace.model.view, before)
  assert.equal(f.workspace.runId, 'fixture-run')
  assert.equal(f.workspace.busy, false)
})
