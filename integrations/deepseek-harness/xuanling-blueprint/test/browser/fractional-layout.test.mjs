// §8.9 production model contracts. Actual GraphEditor/BlueprintWorkspace and
// codecs/revision helpers; in-memory HostLink/storage, not DSH/native UI QA.
import assert from 'node:assert/strict'
import test from 'node:test'
import { GraphEditor } from '../../src/client/graph-editor.ts'
import { BlueprintWorkspace, draftKey } from '../../src/client/workspace.ts'
import { decodeDefinition, validateDefinition } from '../../src/definition/index.ts'
import { documentRevisions } from '../../src/definition/document.ts'

const definition = {
  schemaVersion: 1,
  id: 'fractional-layout',
  name: 'Fractional layout contract',
  resources: {
    worker: { kind: 'agent', path: 'lib/agents/worker.md' },
    prompt: { kind: 'prompt', path: 'lib/prompts/review.md' },
    review: { kind: 'skill', source: { kind: 'shared', rootId: 'fixture', path: 'review' } },
    tools: { kind: 'mcp', bindingId: 'fixture-tools' },
    result: { kind: 'schema', path: 'lib/schemas/result.json' }
  },
  graph: {
    nodes: [
      { id: 'input', kind: 'input', outputs: { request: 'string' } },
      {
        id: 'worker',
        kind: 'agentTask',
        agentRef: 'worker',
        skillRefs: ['review'],
        toolsetRefs: ['tools'],
        outputSchemaRef: 'result',
        inputs: { input: 'string' },
        outputs: { result: 'string' }
      },
      { id: 'output', kind: 'output', inputs: { value: 'string' } }
    ],
    edges: [
      { kind: 'data', from: 'input.request', to: 'worker.input' },
      { kind: 'data', from: 'worker.result', to: 'output.value' }
    ]
  },
  presentation: {
    nodes: { input: { x: 0, y: 0 }, worker: { x: 120, y: 80 }, output: { x: 560, y: -80 } },
    groups: [{ id: 'review-stage', label: 'Review stage', nodeIds: ['input', 'worker'] }]
  },
  metadata: { retained: ['future metadata', { note: 'do not drop', nested: { number: 7, flag: true } }] }
}
const points = [
  ['native-positive', { x: 133.639, y: 119.011 }],
  ['negative', { x: -133.639, y: -119.011 }],
  ['awkward-mixed-sign', { x: 0.10000000000000002, y: -0.3333333333333333 }],
  ['half-adjacent', { x: -0.5000000000000001, y: 1.5000000000000002 }],
  ['subnormal', { x: Number.MIN_VALUE, y: -Number.MIN_VALUE }]
]
function legal(value) {
  const decoded = decodeDefinition(JSON.stringify(value))
  validateDefinition(decoded)
  return decoded
}
// Initial fixture/schema preconditions must hold independently of the targets.
legal(definition)
for (const [, point] of points) {
  assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y))
  legal({ ...definition, presentation: { ...definition.presentation, nodes: { ...definition.presentation.nodes, worker: point } } })
}
function semanticsPreserved(actual, expected = definition) {
  assert.equal(actual.schemaVersion, expected.schemaVersion)
  assert.equal(actual.id, expected.id)
  assert.equal(actual.name, expected.name)
  assert.deepEqual(actual.graph, expected.graph, 'all IDs, ports, edges and node options retained')
  assert.deepEqual(actual.resources, expected.resources, 'resource bindings retained without reading real files/Skills')
  assert.deepEqual(actual.metadata, expected.metadata)
  assert.deepEqual(actual.presentation.groups, expected.presentation.groups)
  assert.equal(documentRevisions(actual, {}).semanticRevision, documentRevisions(expected, {}).semanticRevision)
  legal(actual)
}
function move(editor, point, nodeId = 'worker') {
  editor.beginLayout()
  editor.moveNode(nodeId, point.x, point.y)
  editor.commitLayout()
}
function fixture(initial = definition) {
  let json = JSON.stringify(legal(initial))
  const entries = new Map(),
    calls = [],
    writes = []
  const doc = () => ({ blueprintId: initial.id, definitionJson: json, ...documentRevisions(legal(JSON.parse(json)), {}) })
  const storage = {
    getItem: key => entries.get(key) ?? null,
    setItem(key, value) {
      writes.push({ key, value })
      entries.set(key, value)
    }
  }
  const host = {
    async listDefinitions() {
      calls.push({ method: 'listDefinitions' })
      return {
        definitions: [{ blueprintId: initial.id, name: initial.name, documentRevision: doc().documentRevision, semanticRevision: doc().semanticRevision }]
      }
    },
    async loadDefinition(blueprintId) {
      assert.equal(blueprintId, initial.id)
      calls.push({ method: 'loadDefinition', blueprintId })
      return doc()
    },
    async validate(definitionJson) {
      calls.push({ method: 'validate', definitionJson })
      const accepted = legal(JSON.parse(definitionJson))
      return { ok: true, semanticRevision: documentRevisions(accepted, {}).semanticRevision }
    },
    async saveDefinition(blueprintId, definitionJson, expectedRevision) {
      assert.equal(blueprintId, initial.id)
      assert.equal(expectedRevision, doc().documentRevision, 'actual workspace forwards the original document CAS revision')
      legal(JSON.parse(definitionJson))
      calls.push({ method: 'saveDefinition', blueprintId, definitionJson, expectedRevision })
      json = definitionJson
      return doc()
    },
    async startRun() {
      assert.fail('layout persistence must not start a Run')
    },
    async inspectRun() {
      assert.fail('fixture has no run binding')
    },
    async cancelRun() {
      assert.fail('layout persistence must not cancel a Run')
    },
    async decide() {
      assert.fail('layout persistence must not make a decision')
    }
  }
  return { entries, calls, writes, storage, host, doc }
}
async function loaded(f, useStorage = true) {
  const workspace = new BlueprintWorkspace(f.host, useStorage ? f.storage : undefined)
  await workspace.initialize()
  await workspace.load(definition.id)
  return workspace
}
function assertPoint(editor, expected, id = 'worker') {
  const node = editor.nodes.find(node => node.id === id)
  assert.deepEqual({ x: node.x, y: node.y }, expected, 'actual editor coordinates')
  assert.deepEqual(editor.exportLayout().nodes[id], expected, 'presentation export is lossless')
  assert.deepEqual(editor.exportDefinition().presentation.nodes[id], expected, 'definition export is lossless')
}

for (const [name, point] of points) {
  test(`TARGET export/import finite ${name} coordinates exactly, without presentation quantization`, () => {
    const editor = GraphEditor.fromDefinition(definition)
    move(editor, point)
    assertPoint(editor, point)
    semanticsPreserved(editor.exportDefinition())
    const restored = GraphEditor.fromDefinition(definition)
    restored.importLayout(JSON.parse(JSON.stringify(editor.exportLayout())))
    assertPoint(restored, point)
    assert.equal(restored.canUndo, false)
    assert.equal(restored.undo(), false, 'restore creates zero Undo entries')
    assert.equal(restored.canRedo, false)
  })
  test(`TARGET workspace ${name}: both draft representations, restore and save/host-only reopen retain exact coordinates`, async () => {
    const f = fixture(),
      workspace = await loaded(f),
      before = f.doc()
    f.calls.length = 0
    move(workspace.editor, point)
    assert.equal(workspace.dirty, true)
    assert.deepEqual(f.calls, [], 'local movement/persistence makes no host request')
    const draft = JSON.parse(f.entries.get(draftKey(definition.id)))
    assert.equal(draft.documentRevision, before.documentRevision)
    assert.deepEqual(draft.layout.nodes.worker, point, 'stored layout coordinates')
    assert.deepEqual(JSON.parse(draft.definitionJson).presentation.nodes.worker, point, 'stored definition coordinates')
    semanticsPreserved(JSON.parse(draft.definitionJson))
    const writeCount = f.writes.length
    const restored = await loaded(f)
    assert.deepEqual(
      f.calls.map(call => call.method),
      ['listDefinitions', 'loadDefinition', 'validate']
    )
    assert.equal(f.writes.length, writeCount, 'read-only restoration does not rewrite drafts')
    assertPoint(restored.editor, point)
    assert.equal(restored.dirty, true)
    assert.equal(restored.editor.canUndo, false)
    assert.equal(restored.editor.undo(), false)
    const saved = await restored.save()
    assert.equal(saved.semanticRevision, before.semanticRevision)
    assert.notEqual(saved.documentRevision, before.documentRevision)
    assert.notEqual(saved.layoutRevision, before.layoutRevision)
    assert.deepEqual(JSON.parse(saved.definitionJson).presentation.nodes.worker, point)
    assert.equal(restored.dirty, false)
    assert.deepEqual(JSON.parse(f.entries.get(draftKey(definition.id))).layout.nodes.worker, point)
    const callsBeforeReopen = f.calls.length
    const reopened = await loaded(f, false)
    assert.deepEqual(
      f.calls.slice(callsBeforeReopen).map(call => call.method),
      ['listDefinitions', 'loadDefinition'],
      'host-only reopen never validates/restores a local draft'
    )
    assertPoint(reopened.editor, point)
    assert.equal(reopened.editor.canUndo, false)
    assert.equal(reopened.dirty, false)
    semanticsPreserved(reopened.definition)
  })
}
for (const [name, point] of [
  ['positive', { x: 120 + 2 ** -40, y: 80 + 2 ** -39 }],
  ['negative', { x: 120 - 2 ** -40, y: 80 - 2 ** -39 }]
]) {
  test(`TARGET tiny ${name} fractional-only gesture is dirty, persists, Undo/Redo toggles exact state`, async () => {
    const f = fixture(),
      w = await loaded(f)
    assert.equal(w.dirty, false)
    move(w.editor, point)
    assert.equal(w.dirty, true, 'an exact finite movement smaller than one pixel remains an edit')
    assertPoint(w.editor, point)
    assert.deepEqual(JSON.parse(f.entries.get(draftKey(definition.id))).layout.nodes.worker, point)
    assert.equal(w.editor.undo(), true)
    assertPoint(w.editor, definition.presentation.nodes.worker)
    assert.equal(w.dirty, false)
    assert.equal(w.editor.canUndo, false)
    assert.equal(w.editor.redo(), true)
    assertPoint(w.editor, point)
    assert.equal(w.dirty, true)
    assert.equal(w.editor.canRedo, false)
  })
}
test('TARGET already fractional host definition loads/exports exactly without initialization Undo', async () => {
  const point = points[2][1]
  const initial = structuredClone(definition)
  initial.presentation.nodes.worker = point
  const f = fixture(initial),
    w = await loaded(f)
  assertPoint(w.editor, point)
  assert.equal(w.dirty, false)
  assert.equal(w.editor.canUndo, false)
  assert.equal(w.editor.undo(), false)
  assert.deepEqual(f.writes, [], 'host load is not a draft mutation')
  semanticsPreserved(w.definition, initial)
})
test('TARGET existing finite fractional draft restores exact coordinates with zero Undo and no host mutation', async () => {
  const f = fixture(),
    point = points[1][1]
  const candidate = structuredClone(definition)
  candidate.presentation.nodes.worker = point
  f.entries.set(
    draftKey(definition.id),
    JSON.stringify({ documentRevision: f.doc().documentRevision, definitionJson: JSON.stringify(candidate), layout: candidate.presentation })
  )
  const w = await loaded(f)
  assert.equal(w.status, 'Restored local document draft.')
  assertPoint(w.editor, point)
  assert.equal(w.editor.canUndo, false)
  assert.equal(w.editor.undo(), false)
  assert.equal(w.editor.canRedo, false)
  assert.deepEqual(f.writes, [])
  assert.deepEqual(
    f.calls.map(call => call.method),
    ['listDefinitions', 'loadDefinition', 'validate']
  )
  semanticsPreserved(w.definition)
})
test('TARGET direct workspace save submits exact fractions, reopened host document does not rely on local draft', async () => {
  const f = fixture(),
    w = await loaded(f),
    point = points[0][1],
    before = f.doc()
  move(w.editor, point)
  f.calls.length = 0
  const accepted = await w.save()
  assert.deepEqual(
    f.calls.map(call => call.method),
    ['saveDefinition']
  )
  assert.deepEqual(JSON.parse(f.calls[0].definitionJson).presentation.nodes.worker, point)
  assert.equal(accepted.semanticRevision, before.semanticRevision)
  assertPoint(w.editor, point)
  const callsBeforeReopen = f.calls.length
  const reopened = await loaded(f, false)
  assert.deepEqual(
    f.calls.slice(callsBeforeReopen).map(call => call.method),
    ['listDefinitions', 'loadDefinition']
  )
  assertPoint(reopened.editor, point)
  assert.equal(reopened.dirty, false)
  assert.equal(reopened.editor.canUndo, false)
  semanticsPreserved(reopened.definition)
})
test('TARGET one multi-pointer-move gesture makes exactly one Undo/Redo entry and retains awkward fractions', () => {
  const editor = GraphEditor.fromDefinition(definition)
  const point = points[3][1],
    input = points[2][1]
  editor.beginLayout()
  editor.moveNode('worker', 121.00000000000001, -80.125)
  editor.moveNode('worker', -17.750000000000004, 90.0625)
  editor.moveNode('worker', point.x, point.y)
  editor.moveNode('input', input.x, input.y)
  editor.commitLayout()
  assertPoint(editor, point)
  assertPoint(editor, input, 'input')
  assert.equal(editor.undo(), true)
  assertPoint(editor, definition.presentation.nodes.worker)
  assertPoint(editor, definition.presentation.nodes.input, 'input')
  assert.equal(editor.canUndo, false)
  assert.equal(editor.undo(), false, 'no extra per-pointermove history entries')
  assert.equal(editor.redo(), true)
  assertPoint(editor, point)
  assertPoint(editor, input, 'input')
  assert.equal(editor.canRedo, false)
  semanticsPreserved(editor.exportDefinition())
})
test('CONTROL legacy integer layout-only draft restores, saves/reopens and retains zero restore Undo', async () => {
  const f = fixture(),
    point = { x: -134, y: 119 }
  f.entries.set(
    draftKey(definition.id),
    JSON.stringify({ documentRevision: f.doc().documentRevision, layout: { nodes: { worker: point }, groups: definition.presentation.groups } })
  )
  const w = await loaded(f)
  assertPoint(w.editor, point)
  assert.equal(w.editor.canUndo, false)
  assert.equal(w.editor.undo(), false)
  assert.deepEqual(f.writes, [])
  semanticsPreserved(w.definition)
  await w.save()
  const callsBeforeReopen = f.calls.length
  const reopened = await loaded(f, false)
  assert.deepEqual(
    f.calls.slice(callsBeforeReopen).map(call => call.method),
    ['listDefinitions', 'loadDefinition']
  )
  assertPoint(reopened.editor, point)
  assert.equal(reopened.editor.canUndo, false)
  assert.equal(reopened.dirty, false)
})
for (const [name, invalid] of [
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['negative-Infinity', -Infinity]
]) {
  test(`CONTROL ${name} layout rejection is atomic across coordinates/groups/history/selection`, () => {
    const editor = GraphEditor.fromDefinition(definition)
    move(editor, { x: 140, y: 90 })
    editor.setSelection(['worker'])
    const before = editor.exportDefinition(),
      layout = editor.exportLayout()
    let emissions = 0
    editor.subscribe(() => {
      emissions++
    })
    assert.throws(
      () =>
        editor.importLayout({
          nodes: { worker: points[0][1], input: { x: invalid, y: 7 } },
          groups: [{ id: 'replacement', label: 'Must not apply', nodeIds: ['output'] }]
        }),
      /Invalid layout coordinates/
    )
    assert.deepEqual(editor.exportDefinition(), before)
    assert.deepEqual(editor.exportLayout(), layout)
    assert.deepEqual([...editor.selection], ['worker'])
    assert.equal(emissions, 0)
    assert.equal(editor.canUndo, true)
    assert.equal(editor.canRedo, false)
    assert.equal(editor.undo(), true)
    assertPoint(editor, definition.presentation.nodes.worker)
    assert.equal(editor.canUndo, false)
    assert.equal(editor.redo(), true)
    assertPoint(editor, { x: 140, y: 90 })
  })
}
test('CONTROL malformed persisted nonfinite/null layout retains host document atomically with no restore Undo/write', async () => {
  const f = fixture()
  f.entries.set(
    draftKey(definition.id),
    JSON.stringify({
      documentRevision: f.doc().documentRevision,
      definitionJson: JSON.stringify(definition),
      layout: { nodes: { worker: points[0][1], input: { x: null, y: 7 } } }
    })
  )
  const w = await loaded(f)
  assert.match(w.status, /Invalid local draft ignored; host document retained/)
  assert.deepEqual(w.definition, definition)
  assert.equal(w.editor.canUndo, false)
  assert.equal(w.dirty, false)
  assert.deepEqual(f.writes, [])
  assert.deepEqual(
    f.calls.map(call => call.method),
    ['listDefinitions', 'loadDefinition', 'validate']
  )
})
test('CONTROL presentation edits preserve semantic revision and every resource/ID/metadata/group field', () => {
  const editor = GraphEditor.fromDefinition(definition)
  editor.setSelection(['worker'])
  move(editor, points[0][1])
  const exported = editor.exportDefinition()
  semanticsPreserved(exported)
  assert.deepEqual([...editor.selection], ['worker'])
  assert.deepEqual(definition.presentation.nodes.worker, { x: 120, y: 80 }, 'input definition is not mutated')
  exported.presentation.groups[0].nodeIds.push('output')
  assert.deepEqual(editor.exportLayout().groups, definition.presentation.groups, 'exported groups do not alias editor state')
})
