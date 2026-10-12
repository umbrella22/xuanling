import test from 'node:test'
import assert from 'node:assert/strict'
import { GraphEditor } from '../../src/client/graph-editor.ts'

export const fixture = () => ({ schemaVersion: 1, id: 'flow', name: 'Flow', resources: {}, graph: {
  nodes: [{ id: 'a', kind: 'input', outputs: { '结果.part': 'string' } }, { id: 'b', kind: 'output', inputs: { '输入.part': 'string' } }],
  edges: [{ kind: 'data', from: 'a.结果.part', to: 'b.输入.part' }],
}, presentation: { nodes: { a: { x: 1.25, y: 2 }, b: { x: 100, y: 50 } } } })

test('C03-06 compound editor capabilities exist on the production instance', () => {
  const editor = GraphEditor.fromDefinition(fixture())
  for (const method of ['transaction', 'cancelLayout', 'patchPresentation', 'renameGroup', 'moveGroup', 'alignSelection', 'distributeSelection', 'reconnect', 'createClipboard', 'pasteClipboard']) {
    assert.equal(typeof editor[method], 'function', method)
  }
})

test('C05 control branches are validated for every node kind', () => {
  const d = fixture(); d.graph.nodes[0].branches = ['allowed']
  const editor = GraphEditor.fromDefinition(d)
  assert.deepEqual(editor.connectionVerdict({ nodeId: 'a', port: 'missing', direction: 'out', kind: 'control', type: 'control' }, { nodeId: 'b', port: 'control', direction: 'in', kind: 'control', type: 'control' }), { ok: false, reason: 'undeclared-port' })
})

test('C07 importLayout rejects dangling presentation atomically', () => {
  const editor = GraphEditor.fromDefinition(fixture()); const before = editor.exportDefinition()
  assert.throws(() => editor.importLayout({ nodes: { ghost: { x: 0, y: 0 } } }))
  assert.deepEqual(editor.exportDefinition(), before)
})

const port = (nodeId, direction, name = direction === 'out' ? '结果.part' : '输入.part') => ({ nodeId, direction, port: name, type: 'string' })
const added = (id = 'c') => ({ id, kind: 'output', definition: { id, kind: 'output', inputs: { '输入.part': 'string' } }, inputs: { '输入.part': 'string' }, outputs: {}, label: 'Output', x: 300, y: 80 })

test('C03 create and connect compound command publishes once and undoes once', () => {
  const editor = GraphEditor.fromDefinition(fixture()); const before = editor.exportDefinition(); let emits = 0
  editor.subscribe(() => emits++)
  assert.equal(editor.transaction(() => {
    editor.addNode(added()); assert.equal(emits, 0)
    assert.equal(editor.connect(port('a', 'out'), port('c', 'in')).ok, true); assert.equal(emits, 0)
    return 42
  }), 42)
  assert.equal(emits, 1); assert.equal(editor.edges.length, 2)
  const after = editor.exportDefinition()
  assert.equal(editor.undo(), true); assert.deepEqual(editor.exportDefinition(), before); assert.equal(editor.canUndo, false)
  assert.equal(editor.redo(), true); assert.deepEqual(editor.exportDefinition(), after)
})

test('C03-04 throw preserves graph/resources/points/groups/selection/undo/redo without emit', () => {
  const editor = GraphEditor.fromDefinition(fixture())
  editor.patchPresentation(['a'], { title: 'before' }); editor.patchPresentation(['a'], { color: 'blue' }); editor.undo()
  editor.setSelection(['b']); const before = editor.exportDefinition(); let emits = 0; editor.subscribe(() => emits++)
  assert.throws(() => editor.transaction(() => {
    editor.addNode(added()); editor.edges[0].points = [{ x: 1, y: 2 }]
    editor.patchPresentation(['a'], { title: 'temporary', width: 120 }); editor.setSelection(['a', 'c'])
    editor.groupSelection('temporary'); editor.updateResource('newRef', { kind: 'agent', path: 'lib/new.md' })
    throw new Error('reject')
  }), /reject/)
  assert.equal(emits, 0); assert.deepEqual(editor.exportDefinition(), before); assert.deepEqual([...editor.selection], ['b'])
  assert.equal(editor.canUndo, true); assert.equal(editor.canRedo, true)
  assert.equal(editor.redo(), true); assert.equal(editor.nodes[0].presentation.color, 'blue')
  editor.undo(); editor.undo(); assert.equal(editor.canUndo, false)
})

test('C03 nested savepoint rollback and selection-only/noop never add empty history', () => {
  const editor = GraphEditor.fromDefinition(fixture()); let emits = 0; editor.subscribe(() => emits++)
  editor.transaction(() => {
    editor.addNode(added())
    assert.throws(() => editor.transaction(() => { editor.addNode(added('d')); throw new Error('inner') }), /inner/)
    editor.patchPresentation(['c'], { title: 'kept' })
  })
  assert.equal(emits, 1); assert.equal(editor.nodes.some(n => n.id === 'd'), false)
  editor.undo(); assert.equal(editor.canUndo, false)
  editor.transaction(() => editor.setSelection(['a']))
  assert.equal(editor.canUndo, false); assert.equal(editor.canRedo, true)
  const count = emits; editor.transaction(() => 'noop'); assert.equal(emits, count)
})

test('C06 pending layout cancel/failed transaction preserve gesture and redo, successful command absorbs once', () => {
  const editor = GraphEditor.fromDefinition(fixture())
  editor.patchPresentation(['a'], { title: 'x' }); editor.undo(); editor.setSelection(['a'])
  const before = editor.exportDefinition(); editor.beginLayout(); editor.moveNode('a', 500.5, -40.125)
  assert.throws(() => editor.transaction(() => { editor.addNode(added()); throw new Error('failed pending compound') }), /failed pending compound/)
  assert.equal(editor.nodes[0].x, 500.5); assert.equal(editor.canUndo, false); assert.equal(editor.canRedo, true)
  editor.cancelLayout(); assert.deepEqual(editor.exportDefinition(), before); assert.deepEqual([...editor.selection], ['a'])
  assert.equal(editor.canUndo, false); assert.equal(editor.canRedo, true)
  editor.moveNode('a', 500.5, -40.125); editor.commitLayout(); assert.equal(editor.canUndo, true)
  editor.undo(); assert.deepEqual(editor.exportDefinition(), before)
  editor.moveNode('a', 90, 80); editor.transaction(() => editor.addNode(added())); editor.commitLayout()
  editor.undo(); assert.deepEqual(editor.exportDefinition(), before); assert.equal(editor.canUndo, false)
})

test('C06 group rename/move and align/distribute touch only layout and one undo', () => {
  const d = fixture(); d.graph.nodes.push({ id: 'c', kind: 'output' }); d.presentation.nodes.c = { x: 200, y: 80 }
  const editor = GraphEditor.fromDefinition(d); editor.setSelection(['a', 'b', 'c'])
  const group = editor.groupSelection('组'); editor.renameGroup(group.id, '名字 🪷')
  const beforeMove = editor.exportDefinition(); editor.moveGroup(group.id, 12.5, -4)
  assert.deepEqual(editor.exportDefinition().graph, beforeMove.graph)
  editor.undo(); assert.deepEqual(editor.exportDefinition(), beforeMove)
  const sizes = new Map([['a', { width: 20, height: 10 }], ['b', { width: 40, height: 20 }], ['c', { width: 30, height: 30 }]])
  editor.setSelection(['a', 'b', 'c']); editor.alignSelection('right', sizes)
  assert.equal(new Set(editor.nodes.map(n => n.x + sizes.get(n.id).width)).size, 1)
  editor.undo(); editor.setSelection(['a', 'b', 'c']); editor.distributeSelection('x', sizes)
  const [a, b, c] = editor.nodes
  assert.equal(b.x - (a.x + 20), c.x - (b.x + 40))
  assert.deepEqual(editor.exportDefinition().graph, beforeMove.graph)
  editor.undo(); assert.deepEqual(editor.exportDefinition(), beforeMove)
})

test('C06 pinned drag/group/align/distribute reject with zero movement/history', () => {
  const d = fixture(); d.graph.nodes.push({ id: 'c', kind: 'output' }); d.presentation.nodes.c = { x: 200, y: 80 }
  const editor = GraphEditor.fromDefinition(d); editor.setSelection(['a', 'b', 'c']); const group = editor.groupSelection('all')
  editor.patchPresentation(['a'], { pinned: true }); const before = editor.exportDefinition(); let emits = 0; editor.subscribe(() => emits++)
  editor.moveNode('a', 9, 9)
  for (const fn of [() => editor.moveGroup(group.id, 4, 5), () => editor.alignSelection('left'), () => editor.distributeSelection('x')]) assert.throws(fn, e => e.code === 'pinned-node')
  assert.equal(emits, 0); assert.deepEqual(editor.exportDefinition(), before)
  assert.equal(editor.undo(), true); assert.notEqual(editor.nodes[0].presentation?.pinned, true)
})

test('C06 missing measurements and stale selection are atomic failures', () => {
  const editor = GraphEditor.fromDefinition(fixture()); editor.setSelection(['a', 'b']); const before = editor.exportDefinition()
  assert.throws(() => editor.alignSelection('center-x'), e => e.code === 'missing-measurement')
  editor.setSelection(['a', 'ghost'])
  assert.throws(() => editor.alignSelection('left'), e => e.code === 'stale-selection')
  assert.equal(editor.canUndo, false); assert.deepEqual(editor.exportDefinition(), before)
})

test('C05 reconnect excludes original for cycle/duplicate checks, preserves identity/points, invalid is atomic', () => {
  const editor = GraphEditor.fromDefinition(fixture()); const id = editor.edges[0].id
  editor.edges[0].points = [{ x: 10, y: 20 }]
  const before = editor.exportDefinition(); let emits = 0; editor.subscribe(() => emits++)
  assert.deepEqual(editor.reconnect(id, port('a', 'out'), port('b', 'in')), { ok: true, edge: editor.edges[0] })
  assert.equal(editor.canUndo, false); assert.equal(emits, 0)
  assert.deepEqual(editor.reconnect(id, port('a', 'out'), port('b', 'in', 'missing')), { ok: false, reason: 'undeclared-port' })
  assert.deepEqual(editor.exportDefinition(), before); assert.equal(emits, 0)
  editor.addNode(added()); emits = 0
  assert.equal(editor.reconnect(id, port('a', 'out'), port('c', 'in')).ok, true)
  assert.equal(editor.edges[0].id, id); assert.deepEqual(editor.edges[0].points, [{ x: 10, y: 20 }]); assert.equal(emits, 1)
  assert.equal(editor.exportLayout().edges[0].to, 'c.输入.part')
  editor.undo(); assert.equal(editor.edges[0].to, 'b.输入.part'); assert.deepEqual(editor.edges[0].points, [{ x: 10, y: 20 }])
})

test('C05 duplicate reconnect and data cycle keep original edge and history', () => {
  const d = fixture(); d.graph.nodes.push({ id: 'c', kind: 'output', inputs: { '输入.part': 'string' } }); d.graph.edges.push({ kind: 'data', from: 'a.结果.part', to: 'c.输入.part' })
  const editor = GraphEditor.fromDefinition(d); const before = editor.exportDefinition()
  assert.deepEqual(editor.reconnect(editor.edges[0].id, port('a', 'out'), port('c', 'in')), { ok: false, reason: 'duplicate-edge' })
  assert.deepEqual(editor.exportDefinition(), before); assert.equal(editor.canUndo, false)
})

test('C07 invalid presentation/import/export is strict and atomic, points are cloned in history', () => {
  const editor = GraphEditor.fromDefinition(fixture()); const before = editor.exportDefinition(); let emits = 0; editor.subscribe(() => emits++)
  for (const patch of [{ title: 1 }, { width: 0 }, { height: Infinity }, { color: 'unknown' }, { x: 20 }, { pinned: 'yes' }]) assert.throws(() => editor.patchPresentation(['a', 'b'], patch), e => e.code === 'presentation-invalid')
  for (const layout of [null, { nodes: { a: { x: 8, y: 9 }, ghost: { x: 0, y: 0 } } }, { nodes: { a: { x: 8, y: NaN } } }, { nodes: {}, groups: [{ id: 'g', nodeIds: ['ghost'] }] }, { nodes: {}, edges: [{ kind: 'data', from: 'a.结果.part', to: 'ghost.port', points: [] }] }]) assert.throws(() => editor.importLayout(layout))
  assert.equal(emits, 0); assert.equal(editor.canUndo, false); assert.deepEqual(editor.exportDefinition(), before)
  const layout = editor.exportLayout(); layout.edges = [{ ...before.graph.edges[0], points: [{ x: 3, y: 4 }] }]
  editor.importLayout(layout); layout.edges[0].points[0].x = 999; assert.equal(editor.edges[0].points[0].x, 3)
  editor.transaction(() => { editor.edges[0].points[0].x = 7 }); editor.undo(); assert.equal(editor.edges[0].points[0].x, 3)
  editor.edges[0].points[0].y = Infinity; assert.throws(() => editor.exportLayout(), e => e.code === 'presentation-invalid')
})

test('C03 compound creation rejects missing resource before emit and restores all state', () => {
  const editor = GraphEditor.fromDefinition(fixture()); const before = editor.exportDefinition(); let emits = 0; editor.subscribe(() => emits++)
  assert.throws(() => editor.transaction(() => { editor.addNode(added()); editor.addNode({ ...added('d'), kind: 'agentTask', definition: { id: 'd', kind: 'agentTask', agentRef: 'missing' } }) }))
  assert.equal(emits, 0); assert.equal(editor.canUndo, false); assert.deepEqual(editor.exportDefinition(), before)
})

test('C06 editable invalid draft can rename/pin/layout/delete unrelated items; Host still rejects', async () => {
  const { decodeDefinition } = await import('../../src/definition/codec.ts')
  const { validateDefinition } = await import('../../src/definition/validator.ts')
  const editor = GraphEditor.fromDefinition(fixture())
  editor.updateNode('a', { outputs: {} }); editor.updateNode('b', { agentRef: 'unknown' })
  assert.throws(() => validateDefinition(decodeDefinition(JSON.stringify(editor.exportDefinition()))), e => e.code === 'DEFINITION_INVALID')
  editor.patchPresentation(['a'], { title: 'still editable', pinned: true })
  editor.transaction(() => editor.moveNode('b', 500, 400))
  editor.addNode(added()); editor.transaction(() => editor.deleteItems(['c'], []))
  assert.equal(editor.nodes[0].presentation.title, 'still editable'); assert.equal(editor.nodes[0].presentation.pinned, true)
  assert.equal(editor.nodes[1].x, 500); assert.equal(editor.nodes.some(n => n.id === 'c'), false)
  assert.throws(() => validateDefinition(decodeDefinition(JSON.stringify(editor.exportDefinition()))), e => e.code === 'DEFINITION_INVALID')
})

test('C05 declared branch named control is preserved as @control, every kind obeys branch declarations', () => {
  for (const kind of ['input', 'condition', 'humanDecision', 'agentTask']) {
    const d = fixture(); d.graph.edges = []; d.graph.nodes[0].kind = kind; d.graph.nodes[0].branches = ['control', 'yes']
    const editor = GraphEditor.fromDefinition(d)
    const from = { nodeId: 'a', port: 'control', type: 'control', kind: 'control', direction: 'out' }
    const to = { nodeId: 'b', port: 'control', type: 'control', kind: 'control', direction: 'in' }
    const result = editor.connect(from, to); assert.equal(result.ok, true); assert.equal(result.edge.from, 'a@control')
    assert.deepEqual(editor.connectionVerdict({ ...from, port: 'missing' }, to), { ok: false, reason: 'undeclared-port' })
    assert.deepEqual(editor.connectionVerdict(from, { ...to, port: 'yes' }), { ok: false, reason: 'undeclared-port' })
  }
})

test('C05 reconnect cycle check excludes only old edge, invalid candidate cannot discard points', () => {
  const d = fixture(); d.graph.nodes.push({ id: 'c', kind: 'join', inputs: { in: 'string' }, outputs: { out: 'string' } })
  d.graph.nodes[1].outputs = { out: 'string' }
  d.graph.nodes[0].inputs = { in: 'string' }
  d.graph.edges.push({ kind: 'data', from: 'b.out', to: 'c.in' })
  const editor = GraphEditor.fromDefinition(d); editor.edges[0].points = [{ x: 1, y: 2 }]
  const before = editor.exportDefinition()
  assert.deepEqual(editor.reconnect(editor.edges[1].id, { nodeId: 'b', port: 'out', type: 'string', direction: 'out' }, { nodeId: 'a', port: 'in', type: 'string', direction: 'in' }), { ok: false, reason: 'data-cycle' })
  assert.deepEqual(editor.exportDefinition(), before); assert.equal(editor.canUndo, false)
})

test('C06 stored measurements work and no-op presentation/group/align does not add undo', () => {
  const d = fixture(); for (const p of Object.values(d.presentation.nodes)) { p.width = 40; p.height = 20 }
  const editor = GraphEditor.fromDefinition(d); editor.setSelection(['a', 'b'])
  editor.alignSelection('center-y'); assert.equal(editor.nodes[0].y, editor.nodes[1].y)
  editor.undo(); assert.equal(editor.canUndo, false); editor.setSelection(['a', 'b'])
  editor.patchPresentation(['a'], { width: 40 }); assert.equal(editor.canUndo, false); assert.equal(editor.canRedo, true)
  editor.moveNode('a', editor.nodes[0].x, editor.nodes[0].y); editor.commitLayout(); assert.equal(editor.canUndo, false)
})


test('C03 transaction is synchronous and rejects async callback before its body', () => {
  const editor = GraphEditor.fromDefinition(fixture()); const before = editor.exportDefinition(); let entered = false
  assert.throws(() => editor.transaction(async () => { entered = true; editor.addNode(added()) }), e => e.code === 'transaction-async')
  assert.equal(entered, false); assert.deepEqual(editor.exportDefinition(), before); assert.equal(editor.canUndo, false)
  assert.throws(() => editor.transaction(() => { editor.addNode(added()); return Promise.resolve(1) }), e => e.code === 'transaction-async')
  assert.deepEqual(editor.exportDefinition(), before); assert.equal(editor.canUndo, false)
})
