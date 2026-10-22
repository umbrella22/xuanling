import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeDefinition } from '../../src/definition/codec.ts'
import { validateDefinition } from '../../src/definition/validator.ts'

const base = () => ({
  schemaVersion: 2,
  id: 'flow',
  name: 'Flow',
  resources: {},
  graph: {
    nodes: [
      { id: 'a', kind: 'input' },
      { id: 'b', kind: 'output' }
    ],
    edges: [{ kind: 'control', from: 'a', to: 'b' }]
  }
})
test('C07 strict codec accepts all new presentation fields without semantic extensions', () => {
  const d = base()
  d.presentation = {
    nodes: { a: { x: 1, y: 2, title: '标题 🪷', collapsed: true, pinned: false, width: 220, height: 80, color: 'purple' } },
    edges: [{ kind: 'control', from: 'a', to: 'b', points: [{ x: 12.5, y: -4 }] }]
  }
  assert.deepEqual(decodeDefinition(JSON.stringify(d)), d)
})
test('C07 validator rejects duplicate and dangling presentation edge triples', () => {
  const d = base()
  const edge = { kind: 'control', from: 'a', to: 'b', points: [] }
  d.presentation = { nodes: {}, edges: [edge, edge] }
  assert.throws(
    () => validateDefinition(d),
    e => e.code === 'DEFINITION_INVALID' && e.issues.some(i => i.pointer === '/presentation/edges/1')
  )
})

test('C07 strict shape rejects unknown fields, finite/positive/token/type errors with pointers', () => {
  for (const [field, value] of [
    ['width', 0],
    ['height', -2],
    ['color', 'cyan'],
    ['collapsed', 'yes'],
    ['pinned', 0],
    ['title', 2],
    ['unknown', true],
    ['x', null],
    ['y', null]
  ]) {
    const d = base()
    d.presentation = { nodes: { a: { x: 1, y: 2, [field]: value } } }
    assert.throws(
      () => decodeDefinition(JSON.stringify(d)),
      e => e.code === 'DEFINITION_INVALID' && e.issues.some(i => i.pointer === `/presentation/nodes/a/${field}`),
      field
    )
  }
  const d = base()
  d.presentation = { nodes: {}, edges: [{ ...d.graph.edges[0], points: [{ x: 1, y: null }] }] }
  assert.throws(
    () => decodeDefinition(JSON.stringify(d)),
    e => e.issues.some(i => i.pointer === '/presentation/edges/0/points/0/y')
  )
})

test('C07 presentation references match whole triples including kind and raw endpoints', () => {
  for (const bad of [
    { kind: 'data', from: 'a', to: 'b' },
    { kind: 'control', from: 'a', to: 'ghost' },
    { kind: 'control', from: 'a@missing', to: 'b' }
  ]) {
    const d = base()
    d.presentation = { nodes: {}, edges: [{ ...bad, points: [] }] }
    assert.throws(
      () => validateDefinition(decodeDefinition(JSON.stringify(d))),
      e => e.issues.some(i => i.code === 'dangling-ref' && i.pointer === '/presentation/edges/0')
    )
  }
})

test('C07 old/new definition, editor layout, document revision roundtrip', async () => {
  const { GraphEditor, editorNodeDisplayTitle } = await import('../../src/client/features/authoring/logic/graph/graph-editor.ts')
  const { documentRevisions } = await import('../../src/definition/document.ts')
  const d = base()
  d.metadata = { exact: ['用户', { raw: 'kept' }] }
  d.resources.extra = { kind: 'agent', path: 'lib/agent.md' }
  d.presentation = { nodes: { a: { x: 0.5, y: -2 }, b: { x: 50, y: 60 } }, groups: [{ id: 'g', label: '组', nodeIds: ['a', 'b'] }] }
  assert.deepEqual(decodeDefinition(JSON.stringify(d)), d)
  const editor = GraphEditor.fromDefinition(d)
  const before = editor.exportDefinition()
  const old = documentRevisions(before, {})
  editor.patchPresentation(['a'], { title: '用户 . 🪷', collapsed: true, pinned: true, width: 80.5, height: 30, color: 'amber' })
  editor.transaction(() => {
    editor.edges[0].points = [{ x: 20.5, y: -4 }]
  })
  const after = editor.exportDefinition()
  validateDefinition(decodeDefinition(JSON.stringify(after)))
  const next = documentRevisions(after, {})
  assert.equal(next.semanticRevision, old.semanticRevision)
  assert.notEqual(next.layoutRevision, old.layoutRevision)
  assert.notEqual(next.documentRevision, old.documentRevision)
  const reload = GraphEditor.fromDefinition(decodeDefinition(JSON.stringify(after)))
  assert.deepEqual(reload.exportDefinition(), after)
  assert.notEqual(reload.edges[0].id, editor.edges[0].id)
  assert.equal(
    editorNodeDisplayTitle(reload.nodes[0], 0, () => 'translated'),
    '用户 . 🪷'
  )
  assert.equal(Object.hasOwn(after.graph.nodes[0], 'name'), false)
  assert.deepEqual(after.graph, d.graph)
  assert.deepEqual(after.resources, d.resources)
  assert.deepEqual(after.metadata, d.metadata)
  assert.deepEqual(after.presentation.nodes.a.title, '用户 . 🪷')
})

test('C07 adding presentation validation preserves legacy Host control-edge semantics', () => {
  const d = base()
  d.graph.nodes[0].kind = 'humanDecision'
  d.graph.edges[0].from = 'a@approve'
  d.presentation = { nodes: {}, edges: [{ ...d.graph.edges[0], points: [{ x: 2, y: 3 }] }] }
  assert.doesNotThrow(() => validateDefinition(decodeDefinition(JSON.stringify(d))))
})
