// Anonymous operator actions only; no acceptance facts or substituted Host state.
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { installFixturePolicies, openSession, waitForFixture } from './conversation-fixture.mjs'
import { KEYLESS_SEED_TEXT } from './conversation-runtime.mjs'
import { performanceDefinition } from './canvas-fixtures.mjs'
export { openSession }
export const AUTHOR_ID = 'node-ux-author',
  RUN_ID = 'node-ux-runtime'
export const INPUT = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(k => [k, `anonymous-${k}`]))
export function runtimeDefinition() {
  const ports = Object.fromEntries(Object.keys(INPUT).map(k => [k, 'string']))
  const nodes = [
    { id: 'input', kind: 'input', outputs: ports },
    ...[1, 2, 3, 4].map(i => ({ id: `review-${i}`, kind: 'output' })),
    { id: 'join', kind: 'join', join: 'all' },
    { id: 'decision', kind: 'humanDecision', inputs: ports },
    { id: 'output', kind: 'output' }
  ]
  const edges = [
    ...[1, 2, 3, 4].flatMap(i => [
      { kind: 'control', from: 'input', to: `review-${i}` },
      { kind: 'control', from: `review-${i}`, to: 'join' }
    ]),
    { kind: 'control', from: 'join', to: 'decision' },
    { kind: 'control', from: 'decision@approve', to: 'output' },
    ...Object.keys(ports).map(k => ({ kind: 'data', from: `input.${k}`, to: `decision.${k}` }))
  ]
  const positions = {
    input: { x: 80, y: 100 },
    join: { x: 760, y: 300 },
    decision: {
      x: 1080,
      y: 300,
      width: 220,
      height: 80,
      title: 'Anonymous synthesis review with five independent inputs'
    },
    output: { x: 1400, y: 300 }
  }
  for (let i = 1; i <= 4; i++) positions[`review-${i}`] = { x: 420, y: 100 + (i - 1) * 240 }
  return {
    schemaVersion: 2,
    id: RUN_ID,
    name: 'Anonymous structural waiting workflow',
    resources: {},
    graph: { nodes, edges },
    presentation: {
      nodes: positions,
      groups: [
        {
          id: 'reviews',
          label: 'Independent anonymous reviews',
          nodeIds: ['review-1', 'review-2', 'review-3', 'review-4']
        },
        {
          id: 'shared',
          label: 'Shared top member and synthesis',
          nodeIds: ['review-1', 'decision']
        }
      ]
    }
  }
}
export function authorDefinition() {
  const d = runtimeDefinition()
  d.id = AUTHOR_ID
  d.name = 'Anonymous authoring review workflow'
  d.resources = {
    agent: { kind: 'agent', path: 'lib/agents/review.md' },
    skill: { kind: 'skill', source: { kind: 'host', id: 'node-ux-skill' } },
    mcp: {
      kind: 'mcp',
      source: { kind: 'host', id: 'mcp__bp_host__record_side_effect' },
      bindingId: 'mcp__bp_host__record_side_effect'
    },
    prompt: { kind: 'prompt', path: 'lib/prompt.txt' },
    schema: { kind: 'schema', path: 'lib/schema.json' },
    script: { kind: 'script', path: 'lib/script.js' },
    subflow: { kind: 'subflow', path: 'lib/subflow.json' }
  }
  d.graph.nodes = d.graph.nodes.map(n => (n.id.startsWith('review-') ? { ...n, kind: 'agentTask', agentRef: 'agent' } : n))
  // Deliberate existing overlap exercises the real projection, not fixture acceptance.
  d.presentation.nodes['review-2'].y = 160
  return d
}
export async function prepare({ root, mode }) {
  if (mode !== 'keyless') throw new Error('FIXTURE_MODE_INVALID')
  const { decodeDefinition } = await import('../../../integrations/deepseek-harness/xuanling-blueprint/src/definition/codec.ts')
  const { validateDefinition } = await import('../../../integrations/deepseek-harness/xuanling-blueprint/src/definition/validator.ts')
  for (const d of [runtimeDefinition(), authorDefinition(), performanceDefinition()]) {
    validateDefinition(decodeDefinition(JSON.stringify(d)))
    const dir = join(root, '.xuanling', 'workflows', d.id)
    mkdirSync(join(dir, 'lib/agents'), { recursive: true })
    writeFileSync(join(dir, 'blueprint.json'), JSON.stringify(d))
    for (const ref of Object.values(d.resources))
      if (ref.path) {
        const body =
          ref.kind === 'schema'
            ? '{}'
            : ref.kind === 'subflow'
              ? JSON.stringify({
                  schemaVersion: 2,
                  id: 'nested',
                  name: 'Nested anonymous structural graph',
                  resources: {},
                  graph: { nodes: [{ id: 'out', kind: 'output' }], edges: [] }
                })
              : 'Anonymous fixture resource.\n'
        mkdirSync(dirname(join(dir, ref.path)), { recursive: true })
        writeFileSync(join(dir, ref.path), body)
      }
  }
  const policy = join(root, 'node-ux-session-policy.mjs')
  writeFileSync(
    policy,
    `export const inject=['agents','tools','agentPresets'];\nconst installFixturePolicies=${installFixturePolicies.toString()};\nexport function apply(ctx){installFixturePolicies(ctx,'keyless');ctx.effect(()=>ctx.agentPresets.register({id:'node-ux-agent',name:'node-ux-skill',plugins:[{name:'@deepseek-ai/dsh-persona',config:{prefix:'Anonymous reviewer.',complete:true,includeRuntimeContext:false}}]}))}\n`,
    { flag: 'wx' }
  )
  return { workspaceRoot: root, runtimeRoot: join(root, '.xuanling'), operatorModules: [policy] }
}
export async function arrange({ page, gateway, root }) {
  await gateway.call('workspace/initializeDefault', {})
  const sessionId = `conversation-fixture-node-ux-${randomUUID()}`
  const created = await gateway.call('session/create', {
    request: { sessionId, cwd: join(root, 'cwd'), agentPreset: 'standard' }
  })
  if (created.sessionId !== sessionId) throw new Error('FIXTURE_SESSION_CREATE_MISMATCH')
  await gateway.call('session/prompt', {
    request: {
      sessionId,
      requestId: randomUUID(),
      mode: 'queue',
      content: [{ type: 'text', text: KEYLESS_SEED_TEXT }]
    }
  })
  await waitForFixture(
    () => gateway.call('session/list', { _request: {} }),
    v => v.items?.some(s => s.sessionId === sessionId && !s.running && !s.blank),
    'FIXTURE_SESSION_NOT_IDLE'
  )
  const d = await gateway.call('blueprint/loadDefinition', { args: { blueprintId: RUN_ID } })
  await gateway.call('blueprint/startSessionRun', {
    args: {
      blueprintId: RUN_ID,
      sessionId,
      requestId: randomUUID(),
      expectedRevision: d.documentRevision,
      inputJson: JSON.stringify(INPUT)
    }
  })
  const inspected = await waitForFixture(
    () => gateway.call('blueprint/inspectSession', { args: { sessionId } }),
    v =>
      v.status === 'bound' &&
      v.selected.run.state === 'waiting_input' &&
      v.selected.source?.kind === 'ui' &&
      v.selected.source.sessionId === sessionId &&
      v.selected.focusAttemptIds.length > 0,
    'FIXTURE_WAITING_RUN_NOT_READY'
  )
  await openSession({ page, gateway, sessionId })
  return { sessionId, runId: inspected.selected.run.runId }
}
