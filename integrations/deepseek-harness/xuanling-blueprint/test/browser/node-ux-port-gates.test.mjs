import assert from 'node:assert/strict'
import test from 'node:test'
import { GraphEditor } from '../../src/client/features/authoring/logic/graph/graph-editor.ts'
import { CanvasInteractions } from '../../src/client/features/authoring/logic/graph/flow-interactions.ts'
import { effectivePortVisibility } from '../../src/client/features/authoring/logic/graph/port-visibility.ts'
const node = id => ({
  id,
  kind: 'input',
  inputs: { '入.中文': 'string' },
  outputs: { '出.中文': 'string' }
})
function fixture(edges = []) {
  return GraphEditor.fromDefinition({
    schemaVersion: 2,
    id: 'Gate',
    name: 'Synthetic',
    resources: {},
    graph: { nodes: ['a', 'b', 'c'].map(node), edges },
    presentation: { nodes: { a: { x: 0, y: 0 }, b: { x: 300, y: 0 }, c: { x: 600, y: 0 } } }
  })
}
const port = (nodeId, direction, kind = 'data') => ({
  nodeId,
  direction,
  kind,
  port: kind === 'control' ? 'control' : direction === 'in' ? '入.中文' : '出.中文',
  type: kind === 'control' ? 'control' : 'string'
})
const interactions = editor =>
  new CanvasInteractions(() => ({
    editor,
    blueprintId: 'Gate',
    busy: false,
    locked: false,
    composing: false
  }))
const unchanged = (e, b, undo, redo) => {
  assert.deepEqual(e.exportDefinition(), b)
  assert.equal(e.canUndo, undo)
  assert.equal(e.canRedo, redo)
}
test('default port visibility matrix uses declarations, branch kinds and connected edges', () => {
  for (const kind of ['input', 'output', 'agentTask', 'join', 'unknown'])
    assert.deepEqual(effectivePortVisibility({ id: 'x', kind }, []), {
      control: false,
      inputs: false,
      outputs: false
    })
  for (const kind of ['condition', 'humanDecision']) assert.equal(effectivePortVisibility({ id: 'x', kind }, []).control, true)
  assert.deepEqual(effectivePortVisibility({ id: 'x', kind: 'input', inputs: { '入.中文': 'string' }, outputs: { '出.中文': 'string' } }, []), {
    control: false,
    inputs: true,
    outputs: true
  })
  assert.equal(effectivePortVisibility({ id: 'x', kind: 'input', branches: ['yes'] }, []).control, true)
  assert.equal(
    effectivePortVisibility({ id: 'x', kind: 'input', presentation: { ports: { control: false } } }, [{ kind: 'control', from: 'x', to: 'y' }]).control,
    true
  )
})
test('connected batch close is atomic including existing Undo and Redo', () => {
  const e = fixture([{ kind: 'data', from: 'a.出.中文', to: 'b.入.中文' }])
  e.patchPresentation(['c'], { title: 'changed' })
  e.undo()
  const b = e.exportDefinition()
  assert.throws(
    () => e.patchPresentation(['a', 'c'], { ports: { outputs: false } }),
    x => x.code === 'port-visibility-connected' && x.params.edgeCount === 1
  )
  unchanged(e, b, false, true)
  e.redo()
  assert.equal(e.nodes.find(n => n.id === 'c').presentation.title, 'changed')
  e.undo()
  unchanged(e, b, false, true)
})
test('hidden source/target connect and reconnect reject without replacing original edge', () => {
  for (const side of ['outputs', 'inputs']) {
    const e = fixture()
    e.patchPresentation([side === 'outputs' ? 'a' : 'b'], { ports: { [side]: false } })
    const b = e.exportDefinition()
    assert.equal(e.connect(port('a', 'out'), port('b', 'in')).reason, 'port-hidden')
    unchanged(e, b, true, false)
  }
  const e = fixture([{ kind: 'data', from: 'a.出.中文', to: 'b.入.中文' }])
  e.patchPresentation(['c'], { ports: { inputs: false } })
  const b = e.exportDefinition()
  assert.equal(e.reconnect(e.edges[0].id, port('a', 'out'), port('c', 'in')).reason, 'port-hidden')
  unchanged(e, b, true, false)
})
test('visible type and cycle checks remain active', () => {
  const e = fixture()
  assert.equal(e.connect(port('a', 'out'), { ...port('b', 'in'), type: 'number' }).ok, false)
  assert.equal(e.connect(port('a', 'out'), port('b', 'in')).ok, true)
  assert.equal(e.connect(port('b', 'out'), port('a', 'in')).reason, 'data-cycle')
  assert.equal(e.connect(port('a', 'out'), port('b', 'in')).reason, 'duplicate-edge')
})
test('disconnect permits off and Undo/Redo preserve exact graph and preference', () => {
  const e = fixture([{ kind: 'data', from: 'a.出.中文', to: 'b.入.中文' }])
  e.removeEdge(e.edges[0].id)
  e.patchPresentation(['a'], { ports: { outputs: false } })
  assert.equal(effectivePortVisibility(e.nodes[0], e.edges).outputs, false)
  e.undo()
  assert.equal(e.nodes[0].presentation.ports, undefined)
  e.undo()
  assert.equal(e.edges.length, 1)
  e.redo()
  e.redo()
  assert.equal(e.nodes[0].presentation.ports.outputs, false)
})
test('partial ports patches preserve other sides and unrelated old off contradictions', () => {
  const e = fixture([{ kind: 'control', from: 'a', to: 'b' }])
  const layout = e.exportLayout()
  layout.nodes.a.ports = { control: false }
  e.importLayout(layout)
  e.patchPresentation(['a'], { ports: { inputs: false } })
  e.patchPresentation(['a'], { ports: { outputs: false } })
  assert.deepEqual(e.nodes[0].presentation.ports, {
    control: false,
    inputs: false,
    outputs: false
  })
  assert.equal(effectivePortVisibility(e.nodes[0], e.edges).control, true)
})
test('import edge priority is read-only and clipboard internal canonical edges survive off', () => {
  const e = fixture([{ kind: 'data', from: 'a.出.中文', to: 'b.入.中文' }])
  const layout = e.exportLayout()
  layout.nodes.a.ports = { outputs: false }
  layout.nodes.b.ports = { inputs: false }
  e.importLayout(layout)
  const before = e.exportDefinition()
  assert.equal(effectivePortVisibility(e.nodes[0], e.edges).outputs, true)
  assert.deepEqual(e.exportDefinition(), before)
  const result = e.pasteClipboard(e.createClipboard(['a', 'b']), { x: 1000, y: 500 })
  assert.equal(result.ok, true)
  assert.equal(e.edges.length, 2)
  assert.equal(e.exportLayout().nodes[result.nodeIds[0]].ports.outputs, false)
  e.undo()
  assert.deepEqual(e.exportDefinition(), before)
})
test('clipboard incoming to hidden new side rejects whole transaction', () => {
  const e = fixture([{ kind: 'data', from: 'a.出.中文', to: 'b.入.中文' }])
  const layout = e.exportLayout()
  layout.nodes.b.ports = { inputs: false }
  e.importLayout(layout)
  const fragment = e.createClipboard(['b']),
    before = e.exportDefinition()
  const result = e.pasteClipboard(fragment, { x: 1000, y: 500 }, { withIncoming: true })
  assert.deepEqual(result, { ok: false, code: 'port-hidden', nodeIds: [] })
  unchanged(e, before, false, false)
})
test('drop search hidden origin never leaves node or history; control origin opens new side', () => {
  const e = fixture()
  e.patchPresentation(['a'], { ports: { outputs: false } })
  const before = e.exportDefinition(),
    i = interactions(e)
  assert.equal(i.add('output', { x: 900, y: 0 }, port('a', 'out')), null)
  unchanged(e, before, true, false)
  e.patchPresentation(['a'], { ports: { control: true } })
  const b = e.exportDefinition()
  const id = i.add('output', { x: 900, y: 0 }, port('a', 'out', 'control'))
  assert.ok(id)
  assert.equal(e.exportLayout().nodes[id].ports.control, true)
  assert.equal(e.edges.at(-1).kind, 'control')
  assert.equal(
    effectivePortVisibility(
      e.nodes.find(n => n.id === id),
      e.edges
    ).control,
    true
  )
  e.undo()
  assert.deepEqual(e.exportDefinition(), b)
  i.dispose()
})
