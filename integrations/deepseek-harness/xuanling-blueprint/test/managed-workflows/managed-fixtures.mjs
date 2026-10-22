import { workflowHost, textResponse } from './public-host-fixture.mjs'
import { definition } from '../runtime-contracts/agent-fixtures.mjs'

export async function activeNode(t, script = [textResponse('I will focus on cancellation')], options = {}) {
  const h = await workflowHost(t, { ...options, script })
  const runtime = await h.service.configuredRuntime()
  const doc = definition()
  doc.graph.nodes[0].interaction = 'managed'
  const run = await runtime.store.createRun(
    { scope: 'run', requestId: 'node-message', payloadFingerprint: 'node-message' },
    'frozen',
    JSON.stringify(doc),
    '{}'
  )
  const intent = await runtime.store.recordIntent(run.runId, {
    nodeId: 'work',
    kind: 'agentTask',
    resourceDigests: {},
    sessionIdForAttempt: () => 'node-conversation'
  })
  const handle = await h.ctx.agents.create({
    sessionId: 'node-conversation',
    agentOptions: h.selection,
    meta: { origin: 'subagent', parentSession: h.caller.session.id }
  })
  const stop = new AbortController()
  let unknown = 0
  const binding = runtime.managed.bind(run.runId, intent.attemptId, handle.agent, stop.signal, () => {
    unknown++
  })
  t.after(async () => {
    binding.dispose()
    stop.abort()
    await handle.dispose()
  })
  const args = {
    runId: run.runId,
    attemptId: intent.attemptId,
    sessionId: handle.agent.session.id,
    requestId: 'human-1',
    delivery: 'queue',
    text: 'MESSAGE_BODY_CANARY: focus on cancellation'
  }
  return { ...h, runtime, handle, binding, stop, args, unknown: () => unknown }
}

export async function managedRun(t, script) {
  const h = await workflowHost(t, { preset: 'danger-full-access', script })
  h.ctx.provide('agentDefaultModel', { currentSelection: () => h.selection })
  const idle = Promise.withResolvers()
  h.ctx.on('agent/status', ({ agent, status }) => {
    if (agent.session.id !== h.caller.session.id && status === 'idle') idle.resolve(agent)
  })
  const definition = {
    schemaVersion: 2,
    id: 'managed',
    name: 'Managed review',
    resources: { reviewer: { kind: 'agent', path: 'lib/agents/reviewer.md' } },
    graph: {
      nodes: [{ id: 'review', kind: 'agentTask', interaction: 'managed', agentRef: 'reviewer', outputs: { text: 'string' } }],
      edges: []
    }
  }
  const doc = await h.service.createBlueprint(
    { definition, files: [{ path: 'lib/agents/reviewer.md', text: 'Review cancellation in the implementation. The output is a review.' }] },
    'managed-fixture',
    { sessionId: h.caller.session.id, kind: 'ui' }
  )
  const run = await h.service.startSessionRun({
    sessionId: h.caller.session.id,
    blueprintId: doc.blueprintId,
    expectedRevision: doc.documentRevision,
    inputJson: '{}',
    requestId: 'managed-start'
  })
  const runtime = await h.service.configuredRuntime()
  const agent = await idle.promise
  const record = await runtime.store.get(run.runId)
  const attempt = record.attempts.find(item => item.nodeId === 'review')
  const args = {
    runId: run.runId,
    attemptId: attempt.attemptId,
    sessionId: agent.session.id,
    requestId: 'correction',
    delivery: 'queue',
    text: 'Review cancel during side effect'
  }
  return { ...h, runtime, agent, args, record, job: runtime.jobs.get(run.runId) }
}
