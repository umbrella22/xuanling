import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeDefinition } from '../../src/definition/codec.ts'
import { validateDefinition } from '../../src/definition/validator.ts'
import { computeRevision } from '../../src/definition/revision.ts'
import { GraphEditor } from '../../src/client/graph-editor.ts'
import { decodeClipboard } from '../../src/client/clipboard.ts'
import { frozenPresentationCodec } from '../../src/conversation/contracts.ts'
const definition = () => ({
  schemaVersion: 1,
  id: 'NodeUXCodec',
  name: 'Synthetic',
  resources: {
    Agent: { kind: 'agent', source: { kind: 'host', id: 'synthetic-agent' } }
  },
  graph: {
    nodes: [
      {
        id: 'task',
        kind: 'agentTask',
        agentRef: 'Agent',
        inputs: { '入.口': 'string' },
        outputs: { '出.口': 'string' }
      }
    ],
    edges: []
  },
  presentation: { nodes: { task: { x: 1, y: 2 } } }
})
const ports = { control: false, inputs: true, outputs: false }
const resources = {
  Agent: { title: '显示别名 中文', description: 'Public synthetic description <not HTML>' }
}
function decoded(raw) {
  try {
    const value = decodeDefinition(JSON.stringify(raw))
    validateDefinition(value)
    return { value }
  } catch (error) {
    assert.equal(error.code, 'DEFINITION_INVALID', 'only actual strict-definition rejection is an accepted red')
    return { issues: error.issues }
  }
}
for (const field of ['ports', 'resources']) {
  test(`U11 RED strict definition ${field} accepted, lossless, semantic revision unchanged`, () => {
    const base = definition(),
      raw = structuredClone(base)
    if (field === 'ports') raw.presentation.nodes.task.ports = ports
    else raw.presentation.resources = resources
    const result = decoded(raw)
    assert.ok(result.value, `required presentation field rejected: ${JSON.stringify(result.issues)}`)
    assert.deepEqual(result.value.presentation, raw.presentation)
    const oldRevision = computeRevision({ rootDir: process.cwd(), definition: base })
    const newRevision = computeRevision({ rootDir: process.cwd(), definition: result.value })
    assert.equal(newRevision.semantic, oldRevision.semantic)
    assert.notEqual(newRevision.layout, oldRevision.layout)
    const editor = GraphEditor.fromDefinition(result.value)
    assert.deepEqual(editor.exportDefinition().presentation.nodes.task, raw.presentation.nodes.task)
    if (field === 'resources') assert.deepEqual(editor.exportDefinition().presentation.resources, resources)
  })
  test(`U11 RED strict frozen presentation ${field} accepted without silent dropping`, () => {
    const p = structuredClone(definition().presentation)
    if (field === 'ports') p.nodes.task.ports = ports
    else p.resources = resources
    const result = frozenPresentationCodec().safeParse(p)
    assert.equal(result.success, true, JSON.stringify(result.error?.issues))
    assert.deepEqual(result.data, p)
  })
  test(`U11 RED clipboard ${field} survives strict decode, copy, paste and Undo`, () => {
    const raw = definition()
    const fragment = {
      version: 1,
      sourceBlueprintId: raw.id,
      nodes: raw.graph.nodes,
      edges: [],
      incoming: [],
      resources: raw.resources,
      presentation: structuredClone(raw.presentation)
    }
    if (field === 'ports') fragment.presentation.nodes.task.ports = ports
    else fragment.presentation.resources = resources
    let value, error
    try {
      value = decodeClipboard(fragment)
    } catch (e) {
      assert.equal(e.code, 'clipboard-invalid')
      error = { code: e.code, pointer: e.pointer, message: e.message }
    }
    assert.ok(value, `required clipboard field rejected: ${JSON.stringify(error)}`)
    assert.deepEqual(value.presentation, fragment.presentation)
    const enriched = structuredClone(raw)
    enriched.presentation = fragment.presentation
    const editor = GraphEditor.fromDefinition(enriched)
    assert.deepEqual(editor.createClipboard(['task']).presentation, {
      ...fragment.presentation,
      groups: []
    })
    const before = editor.exportDefinition()
    const result = editor.pasteClipboard(value, { x: 700, y: 500 })
    assert.equal(result.ok, true)
    if (field === 'ports') assert.deepEqual(editor.exportLayout().nodes[result.nodeIds[0]].ports, ports)
    else assert.deepEqual(editor.exportDefinition().presentation.resources, resources)
    assert.equal(editor.undo(), true)
    assert.deepEqual(editor.exportDefinition(), before)
    assert.equal(editor.redo(), true)
  })
}
test('U11 GREEN old schemaVersion 1 remains strict and reversible', () => {
  const raw = definition(),
    result = decoded(raw)
  assert.ok(result.value)
  const editor = GraphEditor.fromDefinition(result.value)
  const old = computeRevision({ rootDir: process.cwd(), definition: raw })
  editor.patchPresentation(['task'], { title: '展示修改' })
  const updated = computeRevision({
    rootDir: process.cwd(),
    definition: editor.exportDefinition()
  })
  assert.equal(updated.semantic, old.semantic)
  assert.notEqual(updated.layout, old.layout)
  assert.equal(editor.undo(), true)
  assert.deepEqual(editor.exportDefinition().presentation.nodes, raw.presentation.nodes)
})
test('U11 GREEN malformed ports, unknown behavior fields and dangling references still reject', () => {
  for (const edit of [
    d => {
      d.graph.nodes[0].executeArbitrary = true
    },
    d => {
      d.presentation.nodes.task.ports = { control: 'false' }
    },
    d => {
      d.presentation.nodes.task.ports = { secretlyRun: true }
    },
    d => {
      d.presentation.resources = { Agent: { title: 42 } }
    },
    d => {
      d.presentation.resources = { Missing: { title: 'dangling' } }
    },
    d => {
      d.presentation.nodes.Missing = { x: 0, y: 0 }
    },
    d => {
      d.graph.edges.push({ kind: 'data', from: 'missing.value', to: 'task.入.口' })
    }
  ]) {
    const raw = definition()
    edit(raw)
    const result = decoded(raw)
    assert.equal(result.value, undefined)
    assert.ok(result.issues.length)
    assert.ok(result.issues.some(issue => typeof issue.pointer === 'string'))
  }
})

test('W4.1 frozen strict rejects unknown metadata without mutating source object', () => {
  const presentation = structuredClone(definition().presentation)
  presentation.nodes.task.unknownMeta = { shouldNotPersist: true }
  const before = structuredClone(presentation)
  const result = frozenPresentationCodec().safeParse(presentation)
  assert.equal(result.success, false)
  assert.deepEqual(presentation, before)
})

test('W4.1 clipboard remaps copied node ids and preserves one-step Undo', () => {
  const editor = GraphEditor.fromDefinition({
    ...definition(),
    graph: {
      nodes: [
        { id: 'a', kind: 'input', outputs: { value: 'string' } },
        { id: 'b', kind: 'output', inputs: { value: 'string' } }
      ],
      edges: [{ kind: 'data', from: 'a.value', to: 'b.value' }]
    },
    presentation: {
      nodes: { a: { x: 0, y: 0 }, b: { x: 300, y: 0 } },
      edges: [{ kind: 'data', from: 'a.value', to: 'b.value', points: [{ x: 10, y: 20 }] }]
    }
  })
  const before = editor.exportDefinition()
  const pasted = editor.pasteClipboard(editor.createClipboard(['a', 'b']), { x: 700, y: 400 })
  assert.equal(pasted.ok, true)
  assert.equal(pasted.nodeIds.length, 2)
  assert.equal(new Set(pasted.nodeIds).size, 2)
  assert.ok(editor.edges.some(edge => pasted.nodeIds.includes(edge.from.split('.')[0]) && pasted.nodeIds.includes(edge.to.split('.')[0])))
  assert.equal(editor.undo(), true)
  assert.deepEqual(editor.exportDefinition(), before)
  assert.equal(editor.canUndo, false)
})
