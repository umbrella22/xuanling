import { workflowHost, textResponse } from './public-host-fixture.mjs'
import { echoDefinition, parentDefinition, save } from './child-fixtures.mjs'
export async function nestedManagedRun(t, script = [textResponse('Please clarify the review focus')]) {
  const h = await workflowHost(t, { preset: 'danger-full-access', script })
  h.ctx.provide('agentDefaultModel', { currentSelection: () => h.selection })
  const idle = Promise.withResolvers()
  h.ctx.on('agent/status', ({ agent, status }) => {
    if (agent.session.id !== h.caller.session.id && status === 'idle') idle.resolve(agent)
  })
  const definition = echoDefinition()
  definition.resources = { reviewer: { kind: 'agent', path: 'lib/reviewer.md' } }
  definition.graph.nodes.splice(1, 0, {
    id: 'work',
    kind: 'agentTask',
    agentRef: 'reviewer',
    interaction: 'managed',
    inputs: { value: 'string' },
    outputs: { value: 'string' }
  })
  definition.graph.edges = [
    { kind: 'data', from: 'in.value', to: 'work.value' },
    { kind: 'data', from: 'work.value', to: 'out.value' }
  ]
  const child = await h.service.createBlueprint(
    { definition, files: [{ path: 'lib/reviewer.md', text: 'Review this task. Ask for focus, then complete with structured_output.' }] },
    'nested-managed',
    { sessionId: h.caller.session.id, kind: 'ui' }
  )
  const parent = await save(h.service, parentDefinition(child))
  const start = await h.service.startSessionRun({
    sessionId: h.caller.session.id,
    blueprintId: parent.blueprintId,
    expectedRevision: parent.documentRevision,
    inputJson: '{"value":"review"}',
    requestId: 'nested-start'
  })
  const runtime = await h.service.configuredRuntime()
  const agent = await idle.promise
  const record = await runtime.store.get(start.runId)
  const call = record.attempts.find(a => a.nodeId === 'call')
  t.after(async () => {
    await h.service.cancelRun({ runId: start.runId }).catch(() => {})
    await runtime.jobs.get(start.runId)
  })
  return { ...h, runtime, agent, record, childRunId: call.childRunId, rootRunId: start.runId }
}
