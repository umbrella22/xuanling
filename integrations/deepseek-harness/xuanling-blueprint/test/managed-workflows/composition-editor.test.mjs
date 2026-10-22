import assert from 'node:assert/strict'
import test from 'node:test'
import { GraphEditor } from '../../src/client/features/authoring/logic/graph/graph-editor.ts'
import { echoDefinition, parentDefinition } from './child-fixtures.mjs'

test('copy and paste preserve child pins and explicit managed interaction without changing their meaning', () => {
  const definition = parentDefinition({ blueprintId: 'child', documentRevision: 'a'.repeat(64) })
  definition.graph.nodes.push({ id: 'agent', kind: 'agentTask', interaction: 'managed', inputs: {}, outputs: {} })
  const editor = GraphEditor.fromDefinition(definition)
  const fragment = editor.createClipboard(['call', 'agent'])
  editor.pasteClipboard(fragment, { x: 500, y: 0 })
  const nodes = editor.exportDefinition().graph.nodes
  assert.deepEqual(
    nodes.filter(n => n.kind === 'blueprintCall').map(n => n.blueprintRef),
    [definition.graph.nodes[1].blueprintRef, definition.graph.nodes[1].blueprintRef]
  )
  assert.deepEqual(
    nodes.filter(n => n.kind === 'agentTask').map(n => n.interaction),
    ['managed', 'managed']
  )
  editor.undo()
  assert.equal(editor.nodes.length, 4)
})

test('clipboard rejects implicit child revisions, foreign managed kinds and removed subflow vocabulary', () => {
  const doc = echoDefinition()
  const editor = GraphEditor.fromDefinition(doc)
  const fragment = editor.createClipboard(['in'])
  for (const node of [
    { id: 'in', kind: 'blueprintCall', blueprintRef: { blueprintId: 'child', documentRevision: 'latest' } },
    { id: 'in', kind: 'input', interaction: 'managed' },
    { id: 'in', kind: 'subflow', subflowRef: 'child' }
  ]) {
    assert.deepEqual(editor.pasteClipboard({ ...fragment, nodes: [node] }, { x: 0, y: 0 }), { ok: false, code: 'clipboard-invalid', nodeIds: [] })
  }
  assert.equal(editor.nodes.length, 2)
})
