// W2.1 source contracts. Translation adapters below are display test doubles,
// not evidence of native DSH registration, locale switching or mounted UI.
import assert from 'node:assert/strict'
import test from 'node:test'
import { BlueprintWorkspace, draftKey, runBindingKey } from '../../src/client/workspace.ts'
import { resourceRows } from '../../src/client/panel.ts'
import { GraphEditor, canConnect, editorNodeDisplayTitle } from '../../src/client/graph-editor.ts'
import { BlueprintRemoteError } from '../../src/client/remote.ts'
import {
  BUILTIN_NODE_CATALOG,
  builtinNodeMetadata,
  searchBuiltinNodes,
  nodeDisplayTitle,
  nodeKindTitle,
  resourceAvailabilityNotice
} from '../../src/client/node-catalog.ts'
import { connectionNotice } from '../../src/client/view-contract.ts'
import { decodeDefinition } from '../../src/definition/codec.ts'
import { validateDefinition } from '../../src/definition/validator.ts'
import { BLUEPRINT_INVOCATIONS } from '../../src/typert-descriptors.ts'

const definition = {
  schemaVersion: 1,
  id: 'space_demo',
  name: '用户标题 / exact title',
  resources: {
    taskAgent: { kind: 'agent', path: 'agents/task.md' },
    sharedSkill: { kind: 'skill', source: { kind: 'shared', rootId: 'shared-root', path: '中文 path / SKILL.md' } },
    second: { kind: 'skill', path: 'skills/second/SKILL.md' },
    differentSkill: { kind: 'skill', path: 'skills/alternate/SKILL.md' }
  },
  graph: {
    nodes: [
      { id: 'source', kind: 'input', outputs: { '用户.port': 'string', exact: 'number' } },
      { id: 'task', kind: 'agentTask', agentRef: 'taskAgent', inputs: { '用户.port': 'string' }, outputs: { result: 'string' }, skillRefs: ['sharedSkill'] },
      { id: 'out', kind: 'output', inputs: { value: 'string' } }
    ],
    edges: [{ kind: 'data', from: 'source.用户.port', to: 'task.用户.port' }]
  },
  metadata: { untouched: ['中文 prompt', { b: 2, a: 1 }] }
}
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
function fixture({ stored, absent = false } = {}) {
  const calls = []
  let checkedArgs
  let doc = absent
    ? null
    : {
        blueprintId: definition.id,
        documentRevision: 'doc-1',
        semanticRevision: 'sem-1',
        layoutRevision: 'layout-1',
        definitionJson: JSON.stringify(definition)
      }
  const data = new Map(stored)
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }
  const snapshot = revision => ({
    runId: 'run-1',
    state: 'succeeded',
    seq: 1,
    definitionRevision: revision,
    attempts: [{ nodeId: 'task', state: 'succeeded', attempt: 1 }],
    logTail: []
  })
  const host = {
    listDefinitions: async () => ({
      definitions: [
        { blueprintId: definition.id, name: definition.name, documentRevision: doc?.documentRevision ?? null, semanticRevision: doc?.semanticRevision ?? null }
      ]
    }),
    loadDefinition: async () => structuredClone(doc),
    validate: async json => {
      calls.push('validate')
      validateDefinition(decodeDefinition(json))
      return { ok: true, semanticRevision: 'sem-1' }
    },
    saveDefinition: async (id, json, expected) => {
      assert.equal(id, definition.id)
      assert.equal(expected, doc?.documentRevision ?? null)
      calls.push('save')
      validateDefinition(decodeDefinition(json))
      doc = { blueprintId: id, definitionJson: json, documentRevision: 'doc-2', semanticRevision: 'sem-2', layoutRevision: 'layout-2' }
      return structuredClone(doc)
    },
    inspectRun: async () => {
      calls.push('inspect')
      return snapshot('sem-1')
    },
    preflightRun: async (blueprintId, expectedRevision, inputJson) => {
      const args = { blueprintId, expectedRevision, inputJson }
      const report = preflightDocument(doc, args)
      checkedArgs = args
      calls.push('preflight')
      return report
    },
    startRun: async (blueprintId, expectedRevision, inputJson, requestId) => {
      assert.deepEqual({ blueprintId, expectedRevision, inputJson }, checkedArgs)
      assert.ok(requestId)
      calls.push('start')
      return { runId: 'run-1', semanticRevision: 'sem-2', state: 'running', replayed: false }
    },
    cancelRun: async () => {
      calls.push('cancel')
      return { runId: 'run-1', state: 'cancelled' }
    },
    decide: async () => {
      calls.push('decide')
    }
  }
  const workspace = new BlueprintWorkspace(host, storage)
  return {
    workspace,
    host,
    calls,
    data,
    storage,
    snapshot,
    load: async () => {
      await workspace.initialize()
      await workspace.load(definition.id)
    }
  }
}
const translations = {
  en: { input: 'Input', agentTask: 'Agent task', humanDecision: 'Approval', condition: 'Condition', join: 'Join (all)', output: 'Output' },
  zh: { input: '输入', agentTask: '智能体任务', humanDecision: '人工决策', condition: '条件', join: '汇合（全部）', output: '输出' }
}
const translate = language => (key, params) =>
  key === 'node.defaultTitle' ? `${params.title} ${params.index}` : (translations[language][key.split('.')[1]] ?? key)

test('foundation fixture satisfies existing definition shape and graph validation without schema changes', () => {
  const decoded = decodeDefinition(JSON.stringify(definition))
  validateDefinition(decoded)
  assert.deepEqual(decoded, definition)
})

test('resource refresh ignores an older response after a newer refresh', async () => {
  const pending = []
  const host = { listResources: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) }
  const workspace = new BlueprintWorkspace(host)
  const first = workspace.refreshResources()
  const second = workspace.refreshResources()
  pending[1].resolve({ resources: [{ source: 'dsh', kind: 'agent', id: 'new', displayName: 'New', description: '', availability: 'available' }] })
  await second
  pending[0].resolve({ resources: [{ source: 'dsh', kind: 'agent', id: 'old', displayName: 'Old', description: '', availability: 'available' }] })
  await first
  assert.equal(workspace.resourceCatalog[0].id, 'new')
  assert.equal(workspace.resourceCatalogState, 'current')
})

test('resource projection does not claim stale Host availability while refresh is pending or unavailable', async () => {
  const old = { source: 'dsh', kind: 'agent', id: 'old', displayName: 'Old', description: '', availability: 'available', provenance: 'custom' }
  const next = { source: 'dsh', kind: 'agent', id: 'next', displayName: 'Next', description: '', availability: 'available', provenance: 'custom' }
  let refreshCount = 0
  let resolveRefresh
  const host = {
    listResources: async () => {
      refreshCount++
      return refreshCount === 1
        ? { resources: [old] }
        : new Promise(resolve => {
            resolveRefresh = () => resolve({ resources: [next] })
          })
    }
  }
  const workspace = new BlueprintWorkspace(host)
  await workspace.refreshResources()
  assert.equal(resourceRows({ resources: {} }, workspace.resourceCatalog, workspace.resourceCatalogState).agent[0].availability, 'available')
  const pending = workspace.refreshResources()
  assert.equal(workspace.resourceCatalogState, 'loading')
  assert.equal(resourceRows({ resources: {} }, workspace.resourceCatalog, workspace.resourceCatalogState).agent[0].availability, 'unknown')
  resolveRefresh()
  await pending
  assert.equal(resourceRows({ resources: {} }, workspace.resourceCatalog, workspace.resourceCatalogState).agent[0].availability, 'available')

  const unavailable = new BlueprintWorkspace({})
  unavailable.resourceCatalog = [old]
  await unavailable.refreshResources()
  assert.equal(unavailable.resourceCatalogState, 'unavailable')
  assert.equal(resourceRows({ resources: {} }, unavailable.resourceCatalog, unavailable.resourceCatalogState).agent[0].availability, 'unknown')
  const owned = resourceRows(
    { resources: { prompt: { kind: 'prompt', path: 'prompts/prompt.md' } } },
    unavailable.resourceCatalog,
    unavailable.resourceCatalogState
  )
  assert.equal(owned.other[0].availability, 'available')
})

test('late Host catalog response is fenced from a new draft generation', async () => {
  const old = { source: 'dsh', kind: 'agent', id: 'old', displayName: 'Old', description: '', availability: 'available', provenance: 'custom' }
  const late = { source: 'dsh', kind: 'agent', id: 'late', displayName: 'Late', description: '', availability: 'available', provenance: 'custom' }
  let calls = 0
  let resolveLate
  const host = {
    listResources: () => {
      calls++
      if (calls === 1) return Promise.resolve({ resources: [old] })
      return new Promise(resolve => {
        resolveLate = () => resolve({ resources: [late] })
      })
    }
  }
  const workspace = new BlueprintWorkspace(host)
  await workspace.refreshResources()
  const stale = workspace.refreshResources()
  workspace.newDraft('New draft')
  resolveLate()
  await stale
  assert.deepEqual(
    workspace.resourceCatalog.map(row => row.id),
    ['old']
  )
  assert.equal(workspace.resourceCatalogState, 'loading')
  const rows = resourceRows({ resources: {} }, workspace.resourceCatalog, workspace.resourceCatalogState)
  assert.equal(rows.agent[0].id, 'old')
  assert.equal(rows.agent[0].availability, 'unknown')
  assert.equal(
    rows.agent.some(row => row.id === 'late'),
    false
  )
})

// These must fail as behavior assertions on the old workspace, not as imports.
test('C-02 stable notices cover initialization, loading, saving and typed failures without raw bodies', async () => {
  const f = fixture()
  assert.deepEqual(f.workspace.notice, { key: 'status.loading' })
  await f.workspace.initialize()
  assert.deepEqual(f.workspace.notice, { key: 'status.chooseBlueprint' })
  await f.workspace.load(definition.id)
  assert.deepEqual(f.workspace.notice, { key: 'status.loaded' })
  await f.workspace.save()
  assert.deepEqual(f.workspace.notice, { key: 'status.saved' })
  const error = new BlueprintRemoteError('blueprint/revision-conflict')
  error.message = '/private/secret raw body never shown'
  error.details = { rawBody: 'not a display parameter' }
  await f.workspace.perform(async () => {
    throw error
  })
  assert.deepEqual(f.workspace.notice, { key: 'status.error', params: { code: 'blueprint/revision-conflict' } })
  assert.equal(JSON.stringify(f.workspace.notice).includes('secret'), false)
  f.workspace.inputJson = '{invalid private input'
  await f.workspace.perform(() => f.workspace.run())
  assert.deepEqual(f.workspace.notice, { key: 'status.invalidRunInput', params: { code: 'blueprint/definition-invalid', issue: 'invalid-input-json' } })
  assert.equal(JSON.stringify(f.workspace.notice).includes('private'), false)
})

test('C-02 absent host/catalog/document and storage failures have distinct stable descriptors', async () => {
  const unavailable = new BlueprintWorkspace(undefined)
  await unavailable.initialize()
  assert.deepEqual(unavailable.notice, { key: 'status.hostUnavailable' })
  const empty = fixture()
  empty.host.listDefinitions = async () => ({ definitions: [] })
  await empty.workspace.initialize()
  assert.deepEqual(empty.workspace.notice, { key: 'status.newDraft' })
  assert.ok(empty.workspace.definition)
  empty.host.listDefinitions = async () => {
    throw new BlueprintRemoteError('blueprint/capability-unavailable')
  }
  await empty.workspace.initialize()
  assert.deepEqual(empty.workspace.notice, { key: 'status.error', params: { code: 'blueprint/capability-unavailable' } })
  const fresh = fixture({ absent: true })
  await fresh.load()
  assert.deepEqual(fresh.workspace.notice, { key: 'status.newDocument' })
  const f = fixture()
  await f.load()
  f.storage.setItem = () => {
    throw new Error('disk denied / private body')
  }
  f.workspace.editor.moveNode('task', 4.25, 7.5)
  assert.deepEqual(f.workspace.notice, { key: 'status.draftUnavailable' })
  f.workspace.runId = 'run-1'
  await f.workspace.inspect()
  assert.deepEqual(f.workspace.notice, { key: 'status.recentRunUnavailable' })
})

test('C-06 overlay requires saved document, matching semantic revision and current run binding', async () => {
  const f = fixture()
  assert.equal(f.workspace.runOverlayEligible, false)
  await f.load()
  assert.equal(f.workspace.runOverlayEligible, false)
  f.workspace.runId = 'run-1'
  f.workspace.model.applySnapshot(f.snapshot('sem-other'))
  assert.equal(f.workspace.runOverlayEligible, false)
  f.workspace.model.applySnapshot({ ...f.snapshot('sem-1'), runId: 'different-run' })
  assert.equal(f.workspace.runOverlayEligible, false)
  f.workspace.model.applySnapshot(f.snapshot('sem-1'))
  assert.equal(f.workspace.runOverlayEligible, true)
  f.workspace.runId = 'different-run'
  assert.equal(f.workspace.runOverlayEligible, false)
  const fresh = fixture({ absent: true })
  await fresh.load()
  fresh.workspace.runId = 'run-1'
  fresh.workspace.model.applySnapshot(fresh.snapshot('sem-1'))
  assert.equal(fresh.workspace.runOverlayEligible, false)
})

test('C-06 layout, grouping and JSON object key order preserve overlay; semantic edits/undo/redo do not', async () => {
  const f = fixture()
  await f.load()
  f.workspace.runId = 'run-1'
  f.workspace.model.applySnapshot(f.snapshot('sem-1'))
  assert.equal(f.workspace.runOverlayEligible, true)
  f.workspace.editor.moveNode('task', -42.25, 180.125)
  f.workspace.editor.setSelection(['source', 'task'])
  f.workspace.editor.groupSelection('用户 group / exact')
  assert.equal(f.workspace.dirty, true)
  assert.equal(f.workspace.runOverlayEligible, true)
  f.workspace.editor.updateNode('source', { outputs: { exact: 'number', '用户.port': 'string' } })
  assert.equal(f.workspace.runOverlayEligible, true, 'object key order is not execution semantics')
  f.workspace.editor.updateNode('source', { outputs: { exact: 'string', '用户.port': 'string' } })
  assert.equal(f.workspace.runOverlayEligible, false)
  assert.equal(f.workspace.model.view.runId, 'run-1')
  f.workspace.editor.undo()
  assert.equal(f.workspace.runOverlayEligible, true)
  f.workspace.editor.redo()
  assert.equal(f.workspace.runOverlayEligible, false)
})

test('C-06 resource identity and array ordering remain semantic; saving requires matching new Run revision', async () => {
  const f = fixture()
  await f.load()
  f.workspace.runId = 'run-1'
  f.workspace.model.applySnapshot(f.snapshot('sem-1'))
  f.workspace.editor.updateResource('sharedSkill', { kind: 'skill', source: { kind: 'shared', rootId: 'different-root', path: '中文 path / SKILL.md' } })
  assert.equal(f.workspace.runOverlayEligible, false)
  f.workspace.editor.undo()
  assert.equal(f.workspace.runOverlayEligible, true)
  f.workspace.editor.updateNode('task', { skillRefs: ['sharedSkill', 'second'] })
  await f.workspace.save()
  assert.equal(f.workspace.runOverlayEligible, false, 'saved baseline alone does not match the old Run')
  f.workspace.model.applySnapshot(f.snapshot('sem-2'))
  assert.equal(f.workspace.runOverlayEligible, true)
  f.workspace.editor.updateNode('task', { skillRefs: ['second', 'sharedSkill'] })
  assert.equal(f.workspace.runOverlayEligible, false, 'array order is not sorted for equivalence')
})

test('C-06 restored semantic draft suppresses overlay; restored presentation-only draft remains eligible and only inspects', async () => {
  for (const semanticEdit of [false, true]) {
    const restored = structuredClone(definition)
    if (semanticEdit) restored.graph.nodes[1].skillRefs = ['differentSkill']
    const draft = {
      documentRevision: 'doc-1',
      definitionJson: JSON.stringify(restored),
      layout: { nodes: { task: { x: 15.25, y: 18.5 } }, groups: [{ id: 'group_restored', label: '用户 stage', nodeIds: ['task'] }] }
    }
    const f = fixture({
      stored: [
        [draftKey(definition.id), JSON.stringify(draft)],
        [runBindingKey(definition.id), JSON.stringify({ blueprintId: definition.id, runId: 'run-1' })]
      ]
    })
    await f.load()
    assert.deepEqual(f.workspace.notice, { key: 'status.draftRestored' })
    assert.equal(f.workspace.runOverlayEligible, !semanticEdit)
    assert.deepEqual(f.calls, ['validate', 'inspect'], 'restore is read-only and never replays a command')
    assert.deepEqual(f.workspace.editor.exportLayout().nodes.task, { x: 15.25, y: 18.5 })
    assert.equal(f.workspace.editor.canUndo, false)
    assert.equal(f.workspace.model.view.runId, 'run-1')
  }
})

test('C-02 stale and invalid drafts keep the host baseline and use stable notices', async () => {
  for (const [draft, key] of [
    [{ documentRevision: 'old', layout: { nodes: {} } }, 'status.draftStale'],
    ['{broken', 'status.draftInvalid']
  ]) {
    const f = fixture({ stored: [[draftKey(definition.id), typeof draft === 'string' ? draft : JSON.stringify(draft)]] })
    await f.load()
    assert.deepEqual(f.workspace.notice, { key })
    assert.deepEqual(f.workspace.definition.graph, definition.graph)
  }
})

test('C-03 builtin catalog exposes exactly six kinds and searches Chinese, English and stable kind IDs', () => {
  assert.deepEqual(
    BUILTIN_NODE_CATALOG.map(node => node.kind),
    ['input', 'agentTask', 'humanDecision', 'condition', 'join', 'output']
  )
  for (const [query, kind] of [
    [' 输入 ', 'input'],
    ['智能体', 'agentTask'],
    ['AGENTTASK', 'agentTask'],
    ['Agent task', 'agentTask'],
    ['审批', 'humanDecision'],
    ['humanDecision', 'humanDecision'],
    ['output', 'output'],
    ['输出', 'output'],
    ['条件', 'condition'],
    ['condition', 'condition'],
    ['汇合', 'join'],
    ['Join all', 'join']
  ]) {
    assert.deepEqual(
      searchBuiltinNodes(query).map(node => node.kind),
      [kind]
    )
  }
  assert.equal(searchBuiltinNodes('').length, 6)
  assert.deepEqual(searchBuiltinNodes('TeamStage'), [])
  assert.equal(builtinNodeMetadata('subflow'), undefined)
  assert.deepEqual(resourceAvailabilityNotice, { key: 'resource.availabilityUnchecked' })
})

test('C-02 display translation never persists generated node labels or translates user titles/IDs', () => {
  const editor = GraphEditor.fromDefinition(definition)
  const before = JSON.stringify(editor.exportDefinition())
  const en = translate('en')
  const zh = translate('zh')
  assert.equal(nodeDisplayTitle(editor.nodes[0].definition, 0, en), 'Input 1')
  assert.equal(nodeDisplayTitle(editor.nodes[0].definition, 0, zh), '输入 1')
  assert.equal(editorNodeDisplayTitle(editor.nodes[0], 0, zh), '输入 1')
  const custom = GraphEditor.fromDefinition({
    ...definition,
    graph: { ...definition.graph, nodes: [{ ...definition.graph.nodes[0], name: '用户 title / exact .%' }] }
  })
  assert.equal(editorNodeDisplayTitle(custom.nodes[0], 0, zh), '用户 title / exact .%')
  assert.equal(custom.exportDefinition().graph.nodes[0].name, '用户 title / exact .%')
  for (const name of ['用户 name / exact .%', '  user title  ', '']) {
    assert.equal(nodeDisplayTitle({ kind: 'agentTask', name }, 7, zh), name)
  }
  assert.equal(nodeKindTitle('condition / unknown', zh), 'condition / unknown')
  assert.equal(JSON.stringify(editor.exportDefinition()), before)
  assert.equal(Object.hasOwn(editor.exportDefinition().graph.nodes[0], 'name'), false)
  assert.deepEqual(editor.exportDefinition().resources, definition.resources)
})

test('C-05 type-conflict verdict carries a stable reason and exact type parameters, not an English sentence', () => {
  const from = { nodeId: 'source', port: '用户.port', direction: 'out', type: 'exact 中文 / 类型.%' }
  const to = { nodeId: 'task', port: '用户.port', direction: 'in', type: 'other / 类型' }
  const verdict = canConnect(from, to)
  assert.deepEqual(verdict, { ok: false, reason: 'type-conflict', params: { fromType: from.type, toType: to.type } })
  assert.deepEqual(connectionNotice(verdict), { key: 'connection.typeConflict', params: { fromType: from.type, toType: to.type } })
  assert.deepEqual(connectionNotice({ ok: true }), null)
})

test('C-05 rejected connections have stable notices and never change definition or undo history', () => {
  const editor = GraphEditor.fromDefinition(definition)
  const from = { nodeId: 'source', port: '用户.port', direction: 'out', type: 'string' }
  const to = { nodeId: 'task', port: '用户.port', direction: 'in', type: 'string' }
  const cases = [
    [{ ...from, direction: 'in' }, to, 'direction-mismatch', 'directionMismatch'],
    [from, { ...to, nodeId: 'source' }, 'self-loop', 'selfLoop'],
    [from, { ...to, kind: 'control' }, 'edge-kind-mismatch', 'edgeKindMismatch'],
    [from, { ...to, nodeId: 'missing / exact' }, 'unknown-node', 'unknownNode'],
    [from, { ...to, port: 'missing' }, 'undeclared-port', 'undeclaredPort'],
    [from, to, 'duplicate-edge', 'duplicateEdge']
  ]
  const before = JSON.stringify(editor.exportDefinition())
  for (const [source, target, reason, suffix] of cases) {
    const verdict = editor.connect(source, target)
    assert.deepEqual(verdict, { ok: false, reason })
    assert.deepEqual(connectionNotice(verdict), { key: `connection.${suffix}` })
    assert.equal(JSON.stringify(editor.exportDefinition()), before)
    assert.equal(editor.canUndo, false)
  }
  // Existing graph has source -> task: the reverse data edge is a cycle.
  const cyclic = GraphEditor.fromDefinition({
    ...definition,
    graph: {
      ...definition.graph,
      nodes: definition.graph.nodes.map(node => ({ ...node, inputs: { value: 'string' }, outputs: { value: 'string' } })),
      edges: [{ kind: 'data', from: 'source.value', to: 'task.value' }]
    }
  })
  assert.deepEqual(connectionNotice(cyclic.connectionVerdict({ ...from, nodeId: 'task', port: 'value' }, { ...to, nodeId: 'source', port: 'value' })), {
    key: 'connection.dataCycle'
  })
})

test('C-02 translating a live edit view preserves draft bytes, selection, history, Run and execution input', async () => {
  const f = fixture()
  await f.load()
  f.workspace.inputJson = '{"workingLanguage":"中文","raw":" exact % / port "}'
  f.workspace.runId = 'run-1'
  f.workspace.model.applySnapshot(f.snapshot('sem-1'))
  f.workspace.editor.moveNode('task', -0.25, 60.75)
  f.workspace.editor.commitLayout()
  f.workspace.editor.setSelection(['task'])
  const capture = () => ({
    definition: JSON.stringify(f.workspace.definition),
    draft: f.data.get(draftKey(definition.id)),
    inputJson: f.workspace.inputJson,
    selected: [...f.workspace.editor.selection],
    canUndo: f.workspace.editor.canUndo,
    canRedo: f.workspace.editor.canRedo,
    runId: f.workspace.runId,
    view: JSON.stringify(f.workspace.model.view),
    eligible: f.workspace.runOverlayEligible,
    calls: [...f.calls]
  })
  const before = capture()
  for (const language of ['zh', 'en', 'zh']) {
    const t = translate(language)
    f.workspace.editor.nodes.forEach((node, index) => editorNodeDisplayTitle(node, index, t))
    searchBuiltinNodes('输入', t)
    assert.deepEqual(capture(), before)
  }
  assert.equal(f.workspace.editor.undo(), true)
  assert.equal(f.workspace.runOverlayEligible, true)
})

test('C-06 recursively reordered valid draft objects match the host semantic baseline without dropping metadata', async () => {
  const reverseObjects = value =>
    Array.isArray(value)
      ? value.map(reverseObjects)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([key, item]) => [key, reverseObjects(item)])
          )
        : value
  const restored = reverseObjects(definition)
  const draft = { documentRevision: 'doc-1', definitionJson: JSON.stringify(restored), layout: { nodes: {} } }
  const f = fixture({
    stored: [
      [draftKey(definition.id), JSON.stringify(draft)],
      [runBindingKey(definition.id), JSON.stringify({ blueprintId: definition.id, runId: 'run-1' })]
    ]
  })
  await f.load()
  assert.equal(f.workspace.runOverlayEligible, true)
  assert.deepEqual(f.workspace.definition.metadata, definition.metadata)
  assert.deepEqual(f.workspace.definition.resources, definition.resources)
})

test('C-02/C-06 existing extra node name is preserved, while derived display labels never change semantic eligibility', async () => {
  // Client compatibility only: do not claim the strict Host schema accepts name,
  // or expand that schema. readHostDefinition/fromDefinition retain given extras.
  const compatible = structuredClone(definition)
  compatible.graph.nodes[1].name = ' 用户 task / exact % '
  const f = fixture()
  f.host.loadDefinition = async () => ({
    blueprintId: definition.id,
    documentRevision: 'doc-1',
    semanticRevision: 'sem-1',
    layoutRevision: 'layout-1',
    definitionJson: JSON.stringify(compatible)
  })
  await f.load()
  f.workspace.runId = 'run-1'
  f.workspace.model.applySnapshot(f.snapshot('sem-1'))
  const task = f.workspace.editor.nodes.find(node => node.id === 'task')
  const before = JSON.stringify(f.workspace.definition)
  for (const language of ['en', 'zh']) {
    assert.equal(editorNodeDisplayTitle(task, 1, translate(language)), compatible.graph.nodes[1].name)
    assert.equal(JSON.stringify(f.workspace.definition), before)
    assert.equal(f.workspace.runOverlayEligible, true)
  }
  task.label = 'display-only label / 不落盘'
  assert.equal(JSON.stringify(f.workspace.definition), before)
  assert.equal(f.workspace.runOverlayEligible, true)
  f.workspace.editor.updateNode('task', { name: 'user changed semantic document field' })
  assert.equal(f.workspace.runOverlayEligible, false, 'exclude only presentation, never silently exclude definition fields')
  f.workspace.editor.undo()
  assert.equal(f.workspace.runOverlayEligible, true)
  assert.equal(f.workspace.definition.graph.nodes[1].name, compatible.graph.nodes[1].name)
})
