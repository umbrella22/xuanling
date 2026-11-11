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

/** W1 RT-04 (C-05): every frozen edge carries a direction arrow; nothing reads live state. */
test('RT-04 RED frozen edges expose markerEnd arrows on the projection', () => {
  const raw = snapshot()
  raw.value.selected.graph.edges = [{ kind: 'data', from: 'a.result', to: 'b.value' }]
  const before = structuredClone(raw)
  const result = projectFrozenCanvas(raw, false, true)
  assert.deepEqual(raw, before)
  assert.equal(result.edges.length, 1)
  const arrow = result.edges[0].markerEnd
  assert.ok(arrow, 'frozen edge must declare a markerEnd arrow (RT-04/C-05)')
  assert.equal(arrow.type, 'arrowclosed')
})

/** W1 RT-03 (C-03): runtime motion projected on edges must reach the frozen edge
 * contract (data marker + motion class), not stay a nodes-only projection. */
test('RT-03 RED active edge light reaches frozen edge data and className', () => {
  const raw = snapshot()
  raw.value.selected.run.state = 'running'
  raw.value.selected.run.attempts = [
    { attemptId: 'at1', nodeId: 'a', attempt: 1, state: 'succeeded' },
    { attemptId: 'at2', nodeId: 'b', attempt: 1, state: 'running' }
  ]
  raw.value.selected.graph.edges = [{ kind: 'data', from: 'a.result', to: 'b.value' }]
  const before = structuredClone(raw)
  const result = projectFrozenCanvas(raw, false, true)
  assert.deepEqual(raw, before)
  assert.equal(result.edges.length, 1)
  const edge = result.edges[0]
  assert.equal(edge.data.motion, 'pulse', 'succeeded source into running target must project an edge pulse (RT-03/C-03)')
  assert.ok(String(edge.className).includes('bp-edge-motion'), 'pulse edge must carry the motion class')
  const staticEdge = (() => {
    const other = snapshot()
    other.value.selected.run.state = 'running'
    other.value.selected.graph.edges = [{ kind: 'data', from: 'a.result', to: 'b.value' }]
    return projectFrozenCanvas(other, false, true).edges[0]
  })()
  assert.notEqual(staticEdge.data.motion, 'pulse', 'unattempted endpoints stay static')
})

/** W1 RT-05 (C-06): the walked path is emphasized after a run settles; unproven
 * condition branches and unattempted targets are never marked. */
test('RT-05 RED settled traversed path marks proven edges only', () => {
  const raw = snapshot()
  raw.value.selected.run.state = 'succeeded'
  raw.value.selected.run.attempts = [
    { attemptId: 'at1', nodeId: 'a', attempt: 1, state: 'succeeded' },
    { attemptId: 'at2', nodeId: 'b', attempt: 1, state: 'succeeded' }
  ]
  raw.value.selected.graph.edges = [
    { kind: 'data', from: 'a.result', to: 'b.value' },
    { kind: 'control', from: 'a', to: 'b' }
  ]
  const before = structuredClone(raw)
  const result = projectFrozenCanvas(raw, false, true)
  assert.deepEqual(raw, before)
  const byHandle = new Map(result.edges.map(edge => [edge.sourceHandle, edge]))
  assert.equal(byHandle.get('data:result').data.traversed, true, 'settled data edge with attempted target is traversed')
  assert.equal(byHandle.get('control:control').data.traversed, true, 'branchless control edge from succeeded source is traversed')
  const conditional = snapshot()
  conditional.value.selected.run.state = 'succeeded'
  conditional.value.selected.graph.nodes.push({
    id: 'gate',
    kind: 'condition',
    condition: { trueBranch: 'yes', falseBranch: 'no' },
    outputs: { picked: 'boolean' }
  })
  conditional.value.selected.presentation.nodes.gate = { x: 900, y: 0 }
  conditional.value.selected.run.attempts.push({ attemptId: 'at3', nodeId: 'gate', attempt: 1, state: 'succeeded' })
  conditional.value.selected.graph.edges = [{ kind: 'control', from: 'gate@yes', to: 'b' }]
  const conditionalResult = projectFrozenCanvas(conditional, false, true)
  const gateEdge = conditionalResult.edges.find(edge => edge.source === 'gate')
  assert.ok(gateEdge, 'fixture must contain the conditional control edge')
  assert.equal(gateEdge.data.traversed, false, 'a condition branch without a proven boolean output is never traversed')
})
