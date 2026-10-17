import assert from 'node:assert/strict'
import test from 'node:test'
import { projectFrozenCanvas } from '../../src/client/features/conversation/ui/conversation-canvas.ts'
const snapshot = () => ({
  connection: 'connected',
  value: {
    status: 'bound',
    sessionId: 'synthetic',
    runs: [],
    selected: {
      run: {
        runId: 'synthetic-run',
        state: 'succeeded',
        seq: 1,
        definitionRevision: 'frozen',
        attempts: [],
        logTail: []
      },
      graph: {
        nodes: [
          { id: 'a', kind: 'input', outputs: { result: 'string' } },
          { id: 'b', kind: 'output', inputs: { value: 'string' } },
          { id: 'c', kind: 'output', inputs: { value: 'string' } }
        ],
        edges: []
      },
      presentation: {
        nodes: { a: { x: 0, y: 0 }, b: { x: 280, y: 0 }, c: { x: 560, y: 0 } },
        groups: [
          { id: 'left', label: '左组', nodeIds: ['a', 'b'] },
          { id: 'right', label: '右组', nodeIds: ['a', 'c'] }
        ]
      },
      focusAttemptIds: []
    }
  }
})
test('U01 RED frozen production group title strips avoid shared-top overlap without writes', () => {
  const raw = snapshot(),
    before = structuredClone(raw)
  const result = projectFrozenCanvas(raw, false, true)
  assert.deepEqual(raw, before)
  assert.equal(result.groups.length, 2)
  const [a, b] = result.groups
  const overlap =
    a.position.y < b.position.y + 44 &&
    a.position.y + 44 > b.position.y &&
    a.position.x < b.position.x + Number(b.style.width) &&
    a.position.x + Number(a.style.width) > b.position.x
  assert.equal(overlap, false, JSON.stringify(result.groups))
})
test('U05/U11 GREEN frozen off preferences never erase canonical existing edges or rewrite DTO', () => {
  const raw = snapshot()
  raw.value.selected.graph.edges = [
    { kind: 'data', from: 'a.result', to: 'b.value' },
    { kind: 'control', from: 'a', to: 'b' }
  ]
  raw.value.selected.presentation.nodes.a.ports = { control: false, outputs: false }
  raw.value.selected.presentation.nodes.b.ports = { control: false, inputs: false }
  const before = structuredClone(raw)
  const result = projectFrozenCanvas(raw, false, true)
  assert.deepEqual(raw, before)
  assert.equal(result.edges.length, 2)
  assert.equal(result.nodes[0].connectable, false)
  assert.ok(result.nodes[0].data.controlOutputs.includes('control'))
  assert.deepEqual(
    result.edges.map(e => [e.source, e.target, e.sourceHandle, e.targetHandle]),
    [
      ['a', 'b', 'data:result', 'data:value'],
      ['a', 'b', 'control:control', 'control:control']
    ]
  )
})
