import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

const url = new URL('../../src/client/shared/styles/runtime-motion.ts', import.meta.url)
const motion = await import(existsSync(url) ? url.href : '../../src/client/features/authoring/logic/run/client-model.ts')

test('C-10 raw Run/Attempt motion is a callable projection boundary', () => {
  assert.equal(typeof motion.projectRuntimeMotion, 'function', 'RAW_RUNTIME_MOTION_PROJECTION_MISSING')
})

const nodes = [
  { id: 'source', kind: 'input', outputs: { '结果.正文': 'string' } },
  { id: 'target', kind: 'agentTask', inputs: { '输入.原文': 'string' }, outputs: { result: 'string' } },
  { id: 'sink', kind: 'output', inputs: { input: 'string' } },
  { id: 'isolated', kind: 'input' }
]
const edges = [
  { kind: 'data', from: 'source.结果.正文', to: 'target.输入.原文' },
  { kind: 'data', from: 'target.result', to: 'sink.input' }
]
const attempt = (nodeId, state, ordinal = 1, extra = {}) => ({ nodeId, state, attempt: ordinal, ...extra })
const snapshot = (attempts, state = 'running') => ({ runId: 'run-fixture', definitionRevision: 'semantic-fixture', seq: 4, state, attempts, logTail: [] })
const input = (overrides = {}) => ({
  nodes,
  edges,
  snapshot: snapshot([attempt('source', 'succeeded'), attempt('target', 'running'), attempt('sink', 'ready')]),
  overlayEligible: true,
  connectionState: 'connected',
  visible: true,
  reducedMotion: false,
  userMotion: 'on',
  ...overrides
})
const project = overrides => motion.projectRuntimeMotion(input(overrides))

test('C-10 active nodes and only proven directional data paths pulse, dotted Unicode ports remain literal', () => {
  for (const sourceState of ['succeeded', 'running']) {
    for (const targetState of ['running', 'preparing']) {
      const result = project({ snapshot: snapshot([attempt('source', sourceState), attempt('target', targetState)]) })
      assert.equal(result.runState, 'running')
      assert.equal(result.loopsAllowed, true)
      assert.equal(result.nodes[1].motion, 'pulse')
      assert.equal(result.edges[0].motion, 'pulse')
      assert.equal(result.edges[1].motion, 'static')
    }
  }
  for (const sourceState of [
    'preparing',
    'ready',
    'waiting_input',
    'cancelling',
    'failed',
    'cancelled',
    'timed_out',
    'skipped',
    'recovery_required',
    '运行中'
  ]) {
    assert.equal(project({ snapshot: snapshot([attempt('source', sourceState), attempt('target', 'running')]) }).edges[0].motion, 'static', sourceState)
  }
  for (const targetState of ['ready', 'waiting_input', 'succeeded', 'failed', 'cancelling', 'recovery_required']) {
    const result = project({ snapshot: snapshot([attempt('source', 'succeeded'), attempt('target', targetState)]) })
    assert.equal(result.nodes[1].motion, 'static')
    assert.equal(result.edges[0].motion, 'static')
  }
})

test('C-10 connection/visibility/reduced/userOff gating keeps raw static state; unmatched overlay suppresses facts', () => {
  for (const gating of [
    { connectionState: 'stale' },
    { connectionState: 'reconnecting' },
    { visible: false },
    { reducedMotion: true },
    { userMotion: 'off' }
  ]) {
    const result = project(gating)
    assert.equal(result.loopsAllowed, false)
    assert.equal(result.nodes[1].state, 'running')
    assert.ok(result.nodes.every(node => node.motion === 'static'))
    assert.ok(result.edges.every(edge => edge.motion === 'static'))
  }
  for (const gating of [{ overlayEligible: false }, { snapshot: null }]) {
    const result = project(gating)
    assert.equal(result.runState, 'idle')
    assert.equal(result.loopsAllowed, false)
    assert.ok(result.nodes.every(node => node.state === 'idle' && node.motion === 'static'))
  }
})

test('C-10 canonical terminal and non-running Run states stop all loops even with a stale active Attempt', () => {
  for (const runState of ['succeeded', 'failed', 'cancelled', 'timed_out', 'queued', 'waiting_input', 'cancelling', 'recovery_required', '已完成']) {
    const result = project({ snapshot: snapshot([attempt('source', 'succeeded'), attempt('target', 'running')], runState) })
    assert.equal(result.loopsAllowed, false, runState)
    assert.ok(result.nodes.every(node => node.motion === 'static'))
    assert.ok(result.edges.every(edge => edge.motion === 'static'))
    assert.equal(result.runState, runState === '已完成' ? 'unknown' : runState)
  }
  assert.equal(project({ snapshot: snapshot([attempt('target', '运行中')]) }).nodes[1].state, 'unknown')
})

test('C-10 latest durable Attempt wins by ordinal and later appended entry on equal ordinal', () => {
  const result = project({ snapshot: snapshot([attempt('source', 'succeeded'), attempt('target', 'waiting_input', 2), attempt('target', 'running', 1)]) })
  assert.equal(result.nodes[1].state, 'waiting_input')
  assert.equal(result.edges[0].motion, 'static')
  const equalOrdinal = project({
    snapshot: snapshot([
      attempt('source', 'succeeded'),
      attempt('target', 'running', 1, { attemptId: 'old' }),
      attempt('target', 'failed', 1, { attemptId: 'new' })
    ])
  })
  assert.equal(equalOrdinal.nodes[1].state, 'failed')
  assert.equal(equalOrdinal.nodes[1].motion, 'static')
  for (const bad of [NaN, 0, -1, 0.5]) assert.equal(project({ snapshot: snapshot([attempt('target', 'running', bad)]) }).nodes[1].state, 'unknown')
})

test('C-10 condition branches derive only from actual succeeded DTO boolean value and matched config', () => {
  const condition = {
    id: 'predicate',
    kind: 'condition',
    inputs: { check: 'boolean' },
    branches: ['是', '否'],
    condition: { inputPort: 'check', trueBranch: '是', falseBranch: '否' }
  }
  const branchNodes = [condition, { id: 'yes', kind: 'output' }, { id: 'no', kind: 'output' }]
  const branchEdges = [
    { kind: 'control', from: 'predicate@是', to: 'yes' },
    { kind: 'control', from: 'predicate@否', to: 'no' }
  ]
  const branchProject = (outputJson, sourceState = 'succeeded', overrides = {}) =>
    project({
      nodes: branchNodes,
      edges: branchEdges,
      snapshot: snapshot([attempt('predicate', sourceState, 1, { outputJson }), attempt('yes', 'running'), attempt('no', 'preparing')]),
      ...overrides
    })
  // Mirrors inspectRun: branch is excluded; outputs and durable value are exposed.
  assert.deepEqual(
    branchProject(JSON.stringify({ outputs: {}, value: true })).edges.map(e => e.motion),
    ['pulse', 'static']
  )
  assert.deepEqual(
    branchProject(JSON.stringify({ outputs: {}, value: false })).edges.map(e => e.motion),
    ['static', 'pulse']
  )
  for (const bad of [undefined, '{', 'null', 'true', '[]', '{"outputs":{}}', '{"branch":"是"}', '{"value":"true"}', '{"value":1}']) {
    assert.ok(
      branchProject(bad).edges.every(edge => edge.motion === 'static'),
      String(bad)
    )
  }
  assert.ok(branchProject('{"value":true}', 'running').edges.every(edge => edge.motion === 'static'))
  assert.ok(branchProject('{"value":true}', 'succeeded', { overlayEligible: false }).edges.every(edge => edge.motion === 'static'))
  assert.ok(
    branchProject('{"value":true}', 'succeeded', { nodes: [{ ...condition, kind: 'humanDecision' }, ...branchNodes.slice(1)] }).edges.every(
      edge => edge.motion === 'static'
    )
  )
  const retried = branchProject('{"value":true}', 'succeeded', {
    snapshot: snapshot([
      attempt('predicate', 'succeeded', 1, { outputJson: '{"outputs":{},"value":true}' }),
      attempt('predicate', 'succeeded', 2, { outputJson: '{"outputs":{},"value":false}' }),
      attempt('yes', 'running'),
      attempt('no', 'running')
    ])
  })
  assert.deepEqual(
    retried.edges.map(edge => edge.motion),
    ['static', 'pulse']
  )
})

test('C-10 unbranched control waits for succeeded source and invalid/undeclared paths stay static', () => {
  const control = [{ kind: 'control', from: 'source', to: 'target' }]
  assert.equal(project({ edges: control }).edges[0].motion, 'pulse')
  assert.equal(project({ edges: control, snapshot: snapshot([attempt('source', 'running'), attempt('target', 'running')]) }).edges[0].motion, 'static')
  const invalid = [
    { kind: 'data', from: 'source.unknown', to: 'target.输入.原文' },
    { kind: 'data', from: 'source.结果.正文', to: 'missing.port' },
    { kind: 'control', from: 'source@unknown', to: 'target' },
    { kind: 'data', from: 'source.constructor', to: 'target.constructor' }
  ]
  assert.ok(project({ edges: invalid }).edges.every(edge => edge.motion === 'static'))
  assert.equal(project({ nodes: [nodes[0], { ...nodes[1], inputs: { '输入.原文': 'boolean' } }], edges: [edges[0]] }).edges[0].motion, 'static')
})

test('C-10 hover/focus projects only incident neighborhood, independently of motion gates and run binding', () => {
  const result = project({ hoveredNodeId: 'source', focusedNodeId: 'sink', userMotion: 'off', overlayEligible: false })
  assert.deepEqual(
    result.nodes.map(node => node.relation),
    ['anchor', 'neighbor', 'anchor', 'none']
  )
  assert.deepEqual(
    result.edges.map(edge => edge.related),
    [true, true]
  )
  assert.ok(result.edges.every(edge => edge.motion === 'static'))
  assert.ok(project({ hoveredNodeId: 'missing' }).nodes.every(node => node.relation === 'none'))
  assert.equal(project({ hoveredNodeId: 'source' }).nodes[2].relation, 'none', 'not transitive highlighting')
})

test('C-10 projection does not mutate or retain node/edge/snapshot objects', () => {
  const source = input({ hoveredNodeId: 'target' }),
    before = structuredClone(source)
  const result = motion.projectRuntimeMotion(source)
  assert.deepEqual(source, before)
  result.nodes[0].state = 'failed'
  result.edges[0].motion = 'static'
  assert.deepEqual(source, before)
  assert.equal(motion.projectRuntimeMotion(source).edges[0].motion, 'pulse')
})
