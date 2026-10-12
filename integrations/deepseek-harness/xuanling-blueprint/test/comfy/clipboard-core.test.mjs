import test from 'node:test'
import assert from 'node:assert/strict'
import { GraphEditor } from '../../src/client/graph-editor.ts'
import { decodeClipboard } from '../../src/client/clipboard.ts'

const fixture = () => ({ schemaVersion: 1, id: 'source', name: 'Flow', resources: {}, metadata: { notCopied: 'runtime/output excluded' }, graph: {
  nodes: [{ id: 'a', kind: 'input', outputs: { '结果.part': 'string' } }, { id: 'b', kind: 'output', inputs: { '输入.part': 'string' } }],
  edges: [{ kind: 'data', from: 'a.结果.part', to: 'b.输入.part' }],
}, presentation: { nodes: { a: { x: 10, y: 20, title: '🪷 . title', width: 200, height: 80, color: 'blue' }, b: { x: 100, y: 150, collapsed: true } }, groups: [{ id: 'g', label: '组 🪷', nodeIds: ['a', 'b'] }], edges: [{ kind: 'data', from: 'a.结果.part', to: 'b.输入.part', points: [{ x: 70.5, y: 90.25 }] }] } })

test('C04 strict v1 declaration fragment; paste remaps nodes/groups/ports/points with one undo', () => {
  const editor = GraphEditor.fromDefinition(fixture()); const before = editor.exportDefinition()
  const fragment = editor.createClipboard(['a', 'b']); assert.equal(editor.canUndo, false)
  assert.deepEqual(Object.keys(fragment).sort(), ['version', 'sourceBlueprintId', 'nodes', 'edges', 'incoming', 'resources', 'presentation'].sort())
  assert.deepEqual(decodeClipboard(JSON.stringify(fragment)), fragment)
  let emits = 0; editor.subscribe(() => emits++)
  const result = editor.pasteClipboard(fragment, { x: 400, y: 500 })
  assert.equal(result.ok, true); assert.equal(result.code, 'clipboard-pasted'); assert.equal(emits, 1)
  const [a, b] = result.nodeIds
  assert.notEqual(a, 'a'); assert.notEqual(b, 'b'); assert.equal(editor.nodes.find(n => n.id === a).x, 400)
  assert.equal(editor.nodes.find(n => n.id === b).y, 630)
  const edge = editor.edges.find(e => e.from === `${a}.结果.part`)
  assert.equal(edge.to, `${b}.输入.part`); assert.deepEqual(edge.points, [{ x: 460.5, y: 570.25 }])
  assert.deepEqual(editor.groups[1].nodeIds, [a, b]); assert.notEqual(editor.groups[1].id, 'g'); assert.equal(editor.groups[1].label, '组 🪷')
  fragment.presentation.nodes.a.title = 'mutated'; assert.equal(editor.nodes.find(n => n.id === a).presentation.title, '🪷 . title')
  const after = editor.exportDefinition(); editor.undo(); assert.deepEqual(editor.exportDefinition(), before); assert.equal(editor.canUndo, false)
  editor.redo(); assert.deepEqual(editor.exportDefinition(), after)
})

test('C04 repeated paste reserves unique node/group IDs and source fragment remains unchanged', () => {
  const editor = GraphEditor.fromDefinition(fixture()); const f = editor.createClipboard(['a', 'b']); const text = JSON.stringify(f)
  const one = editor.pasteClipboard(f, { x: 0, y: 0 }); const two = editor.pasteClipboard(f, { x: 0, y: 0 })
  assert.equal(one.ok, true); assert.equal(two.ok, true)
  assert.equal(new Set(editor.nodes.map(n => n.id)).size, 6); assert.equal(new Set(editor.groups.map(n => n.id)).size, 3)
  assert.equal(JSON.stringify(f), text)
})

test('C04 incoming paste only same blueprint with current endpoints and types, failure preserves redo/selection', () => {
  const editor = GraphEditor.fromDefinition(fixture()); const f = editor.createClipboard(['b'])
  assert.equal(f.edges.length, 0); assert.equal(f.incoming.length, 1)
  const plain = editor.pasteClipboard(f, { x: 300, y: 400 }); assert.equal(plain.ok, true); assert.equal(editor.edges.length, 1)
  editor.undo(); editor.setSelection(['a']); const before = editor.exportDefinition(); let emits = 0; editor.subscribe(() => emits++)
  const linked = editor.pasteClipboard(f, { x: 300, y: 400 }, { withIncoming: true })
  assert.equal(linked.ok, true); assert.equal(editor.edges.length, 2); assert.equal(editor.edges[1].from, 'a.结果.part'); assert.equal(emits, 1)
  editor.undo(); editor.updateNode('a', { outputs: {} }); editor.setSelection(['b']); const staleBefore = editor.exportDefinition(); emits = 0
  assert.deepEqual(editor.pasteClipboard(f, { x: 1, y: 2 }, { withIncoming: true }), { ok: false, code: 'clipboard-invalid', nodeIds: [] })
  assert.deepEqual(editor.exportDefinition(), staleBefore); assert.deepEqual([...editor.selection], ['b']); assert.equal(emits, 0)
  const target = GraphEditor.fromDefinition({ ...fixture(), id: 'target' }); const targetBefore = target.exportDefinition()
  assert.deepEqual(target.pasteClipboard(f, { x: 1, y: 2 }, { withIncoming: true }), { ok: false, code: 'clipboard-incoming-cross-blueprint', nodeIds: [] })
  assert.deepEqual(target.exportDefinition(), targetBefore)
  assert.ok(before)
})

test('C04 malformed/unknown/invalid/cyclic fragment has zero mutation/history/emit', () => {
  const editor = GraphEditor.fromDefinition(fixture()); const f = editor.createClipboard(['a', 'b']); const before = editor.exportDefinition(); let emits = 0; editor.subscribe(() => emits++)
  const changes = [x => { x.version = 2 }, x => { x.runtime = {} }, x => { x.nodes[0].prompt = 'secret' }, x => { x.nodes.push(x.nodes[0]) }, x => { x.edges[0].to = 'b.missing' }, x => { x.edges.push(x.edges[0]) }, x => { x.presentation.edges[0].points[0].x = Infinity }, x => { x.presentation.groups[0].nodeIds.push('ghost') }, x => { x.resources.extra = { kind: 'mcp', bindingId: 'binding' } }, x => { x.nodes[0].outputs['结果.part'] = 'number' }]
  for (const change of changes) { const bad = structuredClone(f); change(bad); assert.deepEqual(editor.pasteClipboard(bad, { x: 0, y: 0 }), { ok: false, code: 'clipboard-invalid', nodeIds: [] }) }
  assert.deepEqual(editor.pasteClipboard('{broken', { x: 0, y: 0 }), { ok: false, code: 'clipboard-invalid', nodeIds: [] })
  assert.equal(emits, 0); assert.equal(editor.canUndo, false); assert.deepEqual(editor.exportDefinition(), before)
})

const resources = {
  agent: { kind: 'agent', path: 'lib/agent.md' },
  shared: { kind: 'skill', source: { kind: 'shared', rootId: 'skills', path: '中文 skill/SKILL.md' } },
  mcp: { kind: 'mcp', bindingId: 'binding' },
  packageSkill: { kind: 'skill', path: 'lib/SKILL.md' },
  schema: { kind: 'schema', path: 'lib/schema.json' },
  subflow: { kind: 'subflow', path: 'lib/subflow.json' },
}
const resourceDefinition = refs => ({ schemaVersion: 1, id: 'source', name: 'Resources', resources: structuredClone(resources), graph: { nodes: [{ id: 'n', kind: 'input', ...refs }], edges: [] } })

test('C04 only directly referenced exact resource declarations are copied, never merged on paste', () => {
  const d = resourceDefinition({ skillRefs: ['shared'], toolsetRefs: ['mcp'] }); const source = GraphEditor.fromDefinition(d); const f = source.createClipboard(['n'])
  assert.deepEqual(f.resources, { shared: resources.shared, mcp: resources.mcp })
  const target = GraphEditor.fromDefinition({ ...d, id: 'target' }); const beforeResources = target.exportDefinition().resources
  assert.equal(target.pasteClipboard(f, { x: 0, y: 0 }).ok, true); assert.deepEqual(target.exportDefinition().resources, beforeResources)
  const changed = { ...d, id: 'target', resources: { ...d.resources, shared: { kind: 'skill', source: { kind: 'shared', rootId: 'other', path: '中文 skill/SKILL.md' } } } }
  const conflict = GraphEditor.fromDefinition(changed); const before = conflict.exportDefinition()
  assert.deepEqual(conflict.pasteClipboard(f, { x: 0, y: 0 }), { ok: false, code: 'clipboard-resource-conflict', nodeIds: [] }); assert.deepEqual(conflict.exportDefinition(), before); assert.equal(conflict.canUndo, false)
})

test('C04 identical package path across blueprints is rejected for every package reference role', () => {
  for (const refs of [{ agentRef: 'agent' }, { skillRefs: ['packageSkill'] }, { outputSchemaRef: 'schema' }, { subflowRef: 'subflow' }]) {
    const d = resourceDefinition(refs); const source = GraphEditor.fromDefinition(d); const f = source.createClipboard(['n'])
    assert.equal(source.pasteClipboard(f, { x: 0, y: 0 }).ok, true)
    const other = GraphEditor.fromDefinition({ ...d, id: 'other' }); const before = other.exportDefinition()
    assert.deepEqual(other.pasteClipboard(f, { x: 0, y: 0 }), { ok: false, code: 'clipboard-resource-conflict', nodeIds: [] })
    assert.deepEqual(other.exportDefinition(), before); assert.equal(other.canUndo, false)
  }
})

test('C04 same-blueprint missing/changed resource declaration rejects before history or emit', () => {
  const d = resourceDefinition({ agentRef: 'agent' }); const f = GraphEditor.fromDefinition(d).createClipboard(['n'])
  for (const targetResources of [{}, { ...resources, agent: { kind: 'agent', path: 'lib/different.md' } }]) {
    const target = GraphEditor.fromDefinition({ ...d, resources: targetResources }); const before = target.exportDefinition(); let emits = 0; target.subscribe(() => emits++)
    assert.deepEqual(target.pasteClipboard(f, { x: 0, y: 0 }), { ok: false, code: 'clipboard-resource-conflict', nodeIds: [] })
    assert.deepEqual(target.exportDefinition(), before); assert.equal(emits, 0); assert.equal(target.canUndo, false)
  }
})

test('C04 dangling/wrong-kind ref is invalid before clipboard emission', () => {
  const d = resourceDefinition({ agentRef: 'missing' }); const editor = GraphEditor.fromDefinition(d)
  assert.throws(() => editor.createClipboard(['n']), e => e.code === 'clipboard-invalid')
  const d2 = resourceDefinition({ agentRef: 'shared' }); assert.throws(() => GraphEditor.fromDefinition(d2).createClipboard(['n']), e => e.code === 'clipboard-invalid')
})

test('C04 unfinished agentTask/subflow/iteration and legacy condition remain copyable declarations', () => {
  const d = { schemaVersion: 1, id: 'unfinished', name: 'Draft', resources: {}, graph: { nodes: ['agentTask', 'condition', 'subflow', 'iteration'].map((kind, i) => ({ id: `n${i}`, kind })), edges: [] } }
  const editor = GraphEditor.fromDefinition(d); const f = editor.createClipboard(d.graph.nodes.map(n => n.id))
  assert.deepEqual(f.nodes, d.graph.nodes)
  const result = editor.pasteClipboard(f, { x: 20, y: 30 }); assert.equal(result.ok, true)
  for (const id of result.nodeIds) assert.deepEqual(Object.keys(editor.exportDefinition().graph.nodes.find(n => n.id === id)).sort(), ['id', 'kind'])
  assert.equal(editor.undo(), true); assert.deepEqual(editor.exportDefinition().graph, d.graph)
})

test('C04 data cycle is rejected by production fragment decoder before paste', () => {
  const editor = GraphEditor.fromDefinition(fixture()); const f = editor.createClipboard(['a', 'b'])
  f.nodes[0].inputs = { reverse: 'string' }; f.nodes[1].outputs = { reverse: 'string' }
  f.edges.push({ kind: 'data', from: 'b.reverse', to: 'a.reverse' })
  assert.throws(() => decodeClipboard(f), e => e.code === 'clipboard-invalid' && e.pointer === '/edges')
  const before = editor.exportDefinition(); assert.equal(editor.pasteClipboard(f, { x: 0, y: 0 }).ok, false)
  assert.deepEqual(editor.exportDefinition(), before); assert.equal(editor.canUndo, false)
})

test('C04 invalid clipboard keeps nonempty undo/redo and selection, and deep routing snapshots', () => {
  const editor = GraphEditor.fromDefinition(fixture())
  editor.patchPresentation(['a'], { title: 'first' }); editor.patchPresentation(['a'], { color: 'amber' }); editor.undo()
  editor.setSelection(['b']); const before = editor.exportDefinition(); let emits = 0; editor.subscribe(() => emits++)
  const fragment = editor.createClipboard(['b']); fragment.incoming[0].from = 'missing.结果.part'
  assert.equal(editor.pasteClipboard(fragment, { x: 10, y: 20 }, { withIncoming: true }).ok, false)
  assert.equal(emits, 0); assert.equal(editor.canUndo, true); assert.equal(editor.canRedo, true)
  assert.deepEqual(editor.exportDefinition(), before); assert.deepEqual([...editor.selection], ['b'])
  editor.redo(); assert.equal(editor.nodes[0].presentation.color, 'amber')
})

test('C04 compatible resource equality is structural, preserves exact source identity across blueprint', () => {
  const d = resourceDefinition({ skillRefs: ['shared'], toolsetRefs: ['mcp'] }); const f = GraphEditor.fromDefinition(d).createClipboard(['n'])
  const target = GraphEditor.fromDefinition({ ...d, id: 'other', resources: { ...d.resources, shared: { source: { path: '中文 skill/SKILL.md', rootId: 'skills', kind: 'shared' }, kind: 'skill' }, mcp: { bindingId: 'binding', kind: 'mcp' } } })
  assert.equal(target.pasteClipboard(f, { x: 0, y: 0 }).ok, true)
})
