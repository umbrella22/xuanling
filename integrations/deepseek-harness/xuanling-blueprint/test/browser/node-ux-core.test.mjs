// W1 production command/projection oracles; not installed/browser acceptance.
import assert from 'node:assert/strict'
import test from 'node:test'
import { GraphEditor } from '../../src/client/graph-editor.ts'
import { presentationGroupFrames } from '../../src/client/presentation.ts'
import { PALETTE_NODE_FOOTPRINT } from '../../src/client/node-placement.ts'

const definition = () => ({
  schemaVersion: 1,
  id: 'NodeUX',
  name: 'Synthetic node UX',
  resources: {},
  graph: {
    nodes: ['a', 'b', 'c', 'd', 'e'].map(id => ({
      id,
      kind: 'input',
      inputs: { '入.口': 'string' },
      outputs: { '出.口': 'string' }
    })),
    edges: []
  }
})
const rect = n => ({ x: n.x, y: n.y, ...PALETTE_NODE_FOOTPRINT })
const overlap = (a, b) =>
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)) > 0 && Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) > 0
const source = (id = 'a', kind = 'data') => ({
  nodeId: id,
  direction: 'out',
  kind,
  port: kind === 'data' ? '出.口' : 'control',
  type: kind === 'data' ? 'string' : 'control'
})
const target = (id = 'b', kind = 'data') => ({
  nodeId: id,
  direction: 'in',
  kind,
  port: kind === 'data' ? '入.口' : 'control',
  type: kind === 'data' ? 'string' : 'control'
})
const state = editor =>
  structuredClone({
    nodes: editor.nodes,
    edges: editor.edges,
    groups: editor.groups,
    canUndo: editor.canUndo,
    canRedo: editor.canRedo
  })
function command(call) {
  try {
    return { value: call() }
  } catch (error) {
    assert.notEqual(error.name, 'TypeError', 'fixture/callability failure is not an accepted red')
    return { error: { code: error.code, message: error.message } }
  }
}

for (const members of [
  [
    ['a', 'b'],
    ['a', 'c']
  ],
  [
    ['a', 'b', 'c'],
    ['a', 'b']
  ]
]) {
  test(`U01 RED group title strips separate shared-top groups ${JSON.stringify(members)}`, () => {
    const editor = GraphEditor.fromDefinition(definition())
    const before = state(editor)
    const groups = members.map((nodeIds, i) => ({ id: `g${i}`, label: `用户组 ${i}`, nodeIds }))
    const frames = presentationGroupFrames(
      groups,
      editor.nodes,
      editor.nodes.map(n => ({ id: n.id, measured: PALETTE_NODE_FOOTPRINT }))
    )
    assert.equal(frames.length, 2)
    assert.deepEqual(state(editor), before, 'projection must not write canonical editor state')
    assert.equal(overlap({ ...frames[0], height: 44 }, { ...frames[1], height: 44 }), false, `production title-strip intersection: ${JSON.stringify(frames)}`)
  })
}

test('U02 RED real five-node default placement leaves full product silhouette space', () => {
  const editor = GraphEditor.fromDefinition(definition())
  const collisions = []
  for (let i = 0; i < editor.nodes.length; i++)
    for (let j = i + 1; j < editor.nodes.length; j++) {
      const a = rect(editor.nodes[i]),
        b = rect(editor.nodes[j])
      if (overlap(a, b))
        collisions.push({
          nodes: [editor.nodes[i].id, editor.nodes[j].id],
          verticalOverlap: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
          a,
          b
        })
    }
  assert.deepEqual(collisions, [], 'positions must come from production placement, not overlapping fixture coordinates')
})

for (const kind of ['data', 'control'])
  for (const hiddenSide of ['source', 'target']) {
    test(`U05 RED ${kind} ${hiddenSide} off rejects verdict and connect atomically`, () => {
      const editor = GraphEditor.fromDefinition(definition())
      // Future presentation is injected ONLY to isolate the existing command gate;
      // strict production decode/patch closure is independently tested by U11/U10.
      if (kind === 'control') for (const id of ['a', 'b']) editor.nodes.find(n => n.id === id).presentation = { ports: { control: true } }
      const n = editor.nodes.find(n => n.id === (hiddenSide === 'source' ? 'a' : 'b'))
      n.presentation = {
        ports: {
          [kind === 'control' ? 'control' : hiddenSide === 'source' ? 'outputs' : 'inputs']: false
        }
      }
      const before = state(editor)
      const verdict = editor.connectionVerdict(source('a', kind), target('b', kind))
      const result = editor.connect(source('a', kind), target('b', kind))
      assert.deepEqual(
        { verdict, result },
        {
          verdict: { ok: false, reason: 'port-hidden' },
          result: { ok: false, reason: 'port-hidden' }
        }
      )
      assert.deepEqual(result, { ok: false, reason: 'port-hidden' })
      assert.deepEqual(state(editor), before, 'reject must leave graph, presentation and history intact')
    })
    test(`U05 RED ${kind} ${hiddenSide} off rejects reconnect without losing original edge`, () => {
      const raw = definition()
      raw.graph.edges = [
        {
          kind,
          from: kind === 'control' ? 'c' : 'c.出.口',
          to: kind === 'control' ? 'd' : 'd.入.口'
        }
      ]
      const editor = GraphEditor.fromDefinition(raw)
      const initial = editor.edges[0]
      assert.ok(initial, 'canonical baseline edge must exist')
      if (kind === 'control') for (const id of ['a', 'b']) editor.nodes.find(n => n.id === id).presentation = { ports: { control: true } }
      const n = editor.nodes.find(n => n.id === (hiddenSide === 'source' ? 'a' : 'b'))
      n.presentation = {
        ports: {
          [kind === 'control' ? 'control' : hiddenSide === 'source' ? 'outputs' : 'inputs']: false
        }
      }
      const before = state(editor)
      const result = command(() => editor.reconnect(initial.id, source('a', kind), target('b', kind)))
      assert.deepEqual(result, { value: { ok: false, reason: 'port-hidden' } })
      assert.deepEqual(state(editor), before)
    })
  }

for (const [kind, id, field] of [
  ['data', 'a', 'outputs'],
  ['data', 'b', 'inputs'],
  ['control', 'a', 'control'],
  ['control', 'b', 'control']
]) {
  test(`U10 RED connected ${kind} ${id}.${field} cannot close and preserves undo`, () => {
    const raw = definition()
    raw.graph.edges = [
      {
        kind,
        from: kind === 'control' ? 'a' : 'a.出.口',
        to: kind === 'control' ? 'b' : 'b.入.口'
      }
    ]
    const editor = GraphEditor.fromDefinition(raw)
    editor.patchPresentation(['c'], { title: 'prior unrelated edit' })
    const before = state(editor)
    const result = command(() => editor.patchPresentation([id], { ports: { [field]: false } }))
    assert.deepEqual(state(editor), before, 'rejected preference must not add or erase a history entry')
    assert.equal(result.error?.code, 'port-visibility-connected', JSON.stringify(result))
    assert.equal(editor.undo(), true)
    assert.deepEqual(editor.edges, before.edges, 'Undo must retain original canonical edge')
    assert.equal(editor.exportLayout().nodes.c.title, undefined, 'Undo must undo only prior unrelated edit')
    assert.equal(editor.redo(), true)
    assert.deepEqual(editor.edges, before.edges)
  })
}

test('U05/U10 RED unconnected toggle is presentation-only and one reversible history step', () => {
  const editor = GraphEditor.fromDefinition(definition())
  const before = editor.exportDefinition()
  const result = command(() => editor.patchPresentation(['a'], { ports: { control: false, inputs: false, outputs: false } }))
  assert.equal(result.error, undefined, JSON.stringify(result))
  assert.deepEqual(editor.exportDefinition().graph, before.graph)
  assert.deepEqual(editor.exportDefinition().resources, before.resources)
  assert.deepEqual(editor.exportLayout().nodes.a.ports, {
    control: false,
    inputs: false,
    outputs: false
  })
  assert.equal(editor.undo(), true)
  assert.equal(editor.exportLayout().nodes.a.ports, undefined)
  assert.equal(editor.redo(), true)
  assert.deepEqual(editor.exportLayout().nodes.a.ports, {
    control: false,
    inputs: false,
    outputs: false
  })
})

test('U05 GREEN type and malformed endpoint gates remain intact with legacy visible ports', () => {
  const editor = GraphEditor.fromDefinition(definition())
  assert.deepEqual(editor.connect(source(), { ...target(), type: 'number' }), {
    ok: false,
    reason: 'type-conflict',
    params: { fromType: 'string', toType: 'number' }
  })
  assert.deepEqual(editor.connect(source(), target('missing')), {
    ok: false,
    reason: 'unknown-node'
  })
  assert.deepEqual(editor.connect(source(), { ...target(), port: 'undeclared' }), {
    ok: false,
    reason: 'undeclared-port'
  })
  assert.equal(editor.canUndo, false)
  assert.deepEqual(editor.edges, [])
})
