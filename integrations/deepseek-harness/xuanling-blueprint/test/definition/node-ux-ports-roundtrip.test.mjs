import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeDefinition } from '../../src/definition/codec.ts'
import { validateDefinition } from '../../src/definition/validator.ts'
import { authoringGuide, validateCandidate } from '../../src/definition/authoring.ts'
import { GraphEditor } from '../../src/client/features/authoring/logic/graph/graph-editor.ts'
import { decodeClipboard } from '../../src/client/features/authoring/logic/graph/clipboard.ts'
import { frozenPresentationCodec } from '../../src/conversation/contracts.ts'
const fixture = () => ({
  schemaVersion: 2,
  id: 'Ports',
  name: 'Synthetic',
  resources: {},
  graph: {
    nodes: [
      { id: 'a', kind: 'input', outputs: { '结果.part': 'string' } },
      { id: 'b', kind: 'output', inputs: { '输入.part': 'string' } }
    ],
    edges: [{ kind: 'data', from: 'a.结果.part', to: 'b.输入.part' }]
  },
  presentation: { nodes: { a: { x: 0, y: 0 }, b: { x: 300, y: 0 } } }
})
const fragment = d => ({
  version: 1,
  sourceBlueprintId: d.id,
  nodes: d.graph.nodes,
  edges: d.graph.edges,
  incoming: [],
  resources: {},
  presentation: d.presentation
})
for (const ports of [{}, { control: false }, { inputs: true, outputs: false }, { control: true, inputs: false, outputs: true }]) {
  test(`W2.1 exact optional ports roundtrip ${JSON.stringify(ports)}`, () => {
    const d = fixture()
    d.presentation.nodes.a.ports = ports
    const decoded = decodeDefinition(JSON.stringify(d))
    validateDefinition(decoded)
    assert.deepEqual(decoded, d)
    assert.deepEqual(frozenPresentationCodec().parse(d.presentation), d.presentation)
    assert.deepEqual(decodeClipboard(fragment(d)).presentation, d.presentation)
    const editor = GraphEditor.fromDefinition(decoded)
    assert.deepEqual(editor.exportLayout().nodes.a.ports, ports)
    const candidate = validateCandidate({ definition: d, files: [] })
    assert.equal(candidate.ok, true, JSON.stringify(candidate))
    assert.deepEqual(candidate.definition.presentation, d.presentation)
  })
}
for (const ports of [null, [], true, { control: 'false' }, { inputs: 0 }, { outputs: null }, { unknown: true }]) {
  test(`W2.1 malformed ports reject across boundaries atomically ${JSON.stringify(ports)}`, () => {
    const d = fixture()
    d.presentation.nodes.a.ports = ports
    assert.throws(
      () => decodeDefinition(JSON.stringify(d)),
      e => e.code === 'DEFINITION_INVALID' && e.issues.some(i => i.pointer.startsWith('/presentation/nodes/a/ports'))
    )
    assert.throws(
      () => validateDefinition(d),
      e => e.code === 'DEFINITION_INVALID'
    )
    assert.equal(frozenPresentationCodec().safeParse(d.presentation).success, false)
    assert.throws(
      () => decodeClipboard(fragment(d)),
      e => e.code === 'clipboard-invalid' && e.pointer.startsWith('/presentation/nodes/a/ports')
    )
    const editor = GraphEditor.fromDefinition(fixture()),
      before = editor.exportDefinition()
    assert.throws(
      () => editor.patchPresentation(['a'], { ports }),
      e => e.code === 'presentation-invalid'
    )
    assert.deepEqual(editor.exportDefinition(), before)
    assert.equal(editor.canUndo, false)
    assert.throws(
      () => editor.importLayout(d.presentation),
      e => e.code === 'presentation-invalid'
    )
    assert.deepEqual(editor.exportDefinition(), before)
  })
}
test('W2.1 authoring describe publishes boolean-only presentation schema', () => {
  const schema = authoringGuide().schema.properties.presentation.properties.nodes.additionalProperties.properties.ports
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(Object.keys(schema.properties).sort(), ['control', 'inputs', 'outputs'])
  for (const item of Object.values(schema.properties)) assert.equal(item.type, 'boolean')
})
test('W2.1 presentation patch/import/copy-paste are exact single-history edits', () => {
  const editor = GraphEditor.fromDefinition(fixture()),
    before = editor.exportDefinition(),
    ports = { control: true, inputs: true, outputs: true }
  editor.patchPresentation(['a'], { ports })
  assert.deepEqual(editor.exportDefinition().graph, before.graph)
  assert.deepEqual(editor.exportLayout().nodes.a.ports, ports)
  assert.equal(editor.undo(), true)
  assert.equal(editor.exportLayout().nodes.a.ports, undefined)
  assert.equal(editor.redo(), true)
  assert.deepEqual(editor.exportLayout().nodes.a.ports, ports)
  const copy = editor.createClipboard(['a', 'b'])
  const beforePaste = editor.exportDefinition()
  const result = editor.pasteClipboard(copy, { x: 700, y: 600 })
  assert.equal(result.ok, true)
  assert.deepEqual(editor.exportLayout().nodes[result.nodeIds[0]].ports, ports)
  assert.equal(editor.edges.at(-1).from, `${result.nodeIds[0]}.结果.part`)
  assert.equal(editor.edges.at(-1).to, `${result.nodeIds[1]}.输入.part`)
  assert.equal(editor.undo(), true)
  assert.deepEqual(editor.exportDefinition(), beforePaste)
  assert.equal(editor.redo(), true)
  const imported = GraphEditor.fromDefinition(fixture())
  imported.importLayout(beforePaste.presentation)
  assert.deepEqual(imported.exportLayout().nodes.a.ports, ports)
  assert.equal(imported.canUndo, false)
})
