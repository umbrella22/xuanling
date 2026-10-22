import assert from 'node:assert/strict'
import test from 'node:test'
import { BlueprintAgentExecutor } from '../../src/host/agent-executor.ts'
import { workflowHost, textResponse, toolResponse } from './public-host-fixture.mjs'

for (const interaction of [undefined, 'managed'])
  test(`native Team profile: ${interaction ?? 'one-shot'} Blueprint child retains its non-Team identity before publication`, async t => {
    const response = interaction === 'managed' ? toolResponse('structured_output', { text: 'review complete' }) : textResponse('review complete')
    const h = await workflowHost(t, { team: true, script: [response] })
    const published = []
    h.ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.parentSession !== h.caller.id) return
      published.push({
        sessionId: agent.id,
        descriptor: agent.session.snapshotEvents().find(event => event.type === 'subagent/descriptor')?.data,
        membership: h.ctx.agentTeams.tryMembership(agent)
      })
    })
    const evidence = await new BlueprintAgentExecutor(h.ctx, h.ctx.agents).execute({
      runId: 'team-profile',
      attemptId: 'review-attempt',
      nodeId: 'review',
      sessionId: `team-profile-${interaction ?? 'one-shot'}`,
      ...(interaction === undefined ? {} : { interaction }),
      source: { sessionId: h.caller.id, kind: 'ui' },
      agentMd: 'Review only this text.',
      skills: [],
      input: 'Review this synthetic text.',
      cwd: process.cwd(),
      modelSelection: h.selection
    })
    assert.equal(evidence.outcome.kind, 'succeeded', 'the native Team prompt must not reject a Blueprint child as TEAM_NOT_MEMBER')
    assert.equal(h.adapter.requests.length, 1, 'the child reaches the actual AgentLoop model boundary')
    assert.equal(published.length, 1)
    assert.equal(published[0].membership, undefined, 'a Blueprint node never becomes a separate Team Lead')
    assert.equal(published[0].descriptor?.provider, 'xuanling-blueprint')
    assert.equal(published[0].descriptor?.mode, 'one-shot', 'generic continuation remains disabled')
    assert.equal(h.ctx.agentTeams.membership(h.caller).role, 'lead')
    assert.equal(h.ctx.agentTeams.listMembers(h.caller).length, 1, 'ordinary Blueprint execution adds no teammate')
    assert.ok(h.ctx.tools.get('spawn_teammate', h.caller), 'the source Lead keeps native Team tools')
    assert.ok(!(h.adapter.requests[0].tools ?? []).some(tool => tool.name === 'spawn_teammate'))
    const stored = await h.ctx.sessionPersistence.open(published[0].sessionId, 'read')
    try {
      const { events } = await stored.read()
      const descriptor = events.findIndex(event => event.type === 'subagent/descriptor')
      const turn = events.findIndex(event => event.type === 'turn/start')
      assert.ok(descriptor >= 0 && descriptor < turn, 'the published non-Team identity is durable before any turn')
    } finally {
      await stored.close()
    }
  })

test('native child descriptor persistence failure prevents publication, model dispatch and raw error disclosure', async t => {
  const h = await workflowHost(t, { team: true, script: [] })
  const persistence = h.ctx.sessionPersistence
  const create = persistence.create.bind(persistence)
  let failed = false
  const childId = 'failed-native-descriptor'
  t.mock.method(persistence, 'create', async (...args) => {
    const handle = await create(...args)
    if (args[0].id !== childId) return handle
    const append = handle.append.bind(handle)
    handle.append = async (...values) => {
      if (values[0].some(event => event.type === 'subagent/descriptor')) {
        failed = true
        throw new Error('NATIVE_FLUSH_SECRET_SENTINEL /private/native-storage')
      }
      return append(...values)
    }
    return handle
  })
  const evidence = await new BlueprintAgentExecutor(h.ctx, h.ctx.agents)
    .execute({
      runId: 'publication-failure',
      attemptId: 'review-attempt',
      nodeId: 'review',
      sessionId: childId,
      source: { sessionId: h.caller.id, kind: 'ui' },
      agentMd: 'Review only.',
      skills: [],
      input: 'review',
      cwd: process.cwd(),
      modelSelection: h.selection
    })
    .catch(error => error)
  assert.ok(failed, 'the real factory persisted the setup descriptor through its native JSONL handle')
  assert.equal(evidence.code, 'AGENT_COMPOSITION_UNSUPPORTED')
  assert.equal(h.adapter.requests.length, 0)
  assert.equal(h.ctx.agents.get(childId), undefined)
  assert.equal(h.ctx.sessions.get(childId), undefined)
  assert.equal(h.caller.session.snapshotEvents().filter(event => event.type === 'subagent/catalog').length, 0)
  assert.ok(!String(evidence).includes('NATIVE_FLUSH_SECRET_SENTINEL'))
  assert.ok(!String(evidence).includes('/private/native-storage'))
})
