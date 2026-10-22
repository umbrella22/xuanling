import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BlueprintService } from '../../src/index.ts'
import { openBlueprintDomain, RunQuery, RunStore } from '../../src/persistence/index.ts'
import { RunReadService } from '../../src/service/run-read-service.ts'
import { TeamStageObservations } from '../../src/teamstage/observability.ts'
import { focusAttemptsForSession } from '../../src/conversation/run-projection.ts'

async function fixture(t, _backend) {
  const root = await mkdtemp(join(tmpdir(), 'teamstage-member-reader-'))
  const opened = await openBlueprintDomain({ path: join(root, 'store') })
  t.after(async () => {
    await opened.close()
    await rm(root, { recursive: true, force: true })
  })
  const store = new RunStore(opened.domain)
  const definition = {
    schemaVersion: 2,
    id: 'member-reader',
    name: 'Member reader',
    resources: {},
    graph: {
      nodes: [
        { id: 'work', kind: 'agentTask' },
        { id: 'output', kind: 'output' }
      ],
      edges: []
    }
  }
  const { runId } = await store.createRun(
    { scope: 'member-reader', requestId: 'run', payloadFingerprint: 'a'.repeat(64) },
    'revision',
    JSON.stringify(definition),
    '{}',
    { source: { kind: 'ui', sessionId: 'lead-session' } }
  )
  const attempt = await store.recordIntent(runId, { nodeId: 'work', kind: 'agentTask' })
  await store.bindTeamStage(runId, {
    stageId: 'work',
    teamId: 'lead-session',
    leadSessionId: 'lead-session',
    attemptId: attempt.attemptId,
    taskSpecificationFingerprint: 'b'.repeat(64)
  })
  await store.bindTeamTask(runId, { taskId: 'task', taskRevision: 1 })
  await store.updateTeamStage(runId, {
    members: [{ memberId: 'primary', name: 'native-primary', sessionId: 'member-session', phase: 'active', status: 'running' }]
  })
  await store.recordIntent(runId, { nodeId: 'output', kind: 'output' })
  const service = Object.create(BlueprintService.prototype)
  service.checkArgs = () => {}
  service.decodeOrThrow = JSON.parse
  service.teamObservations = new TeamStageObservations()
  service.runReads = handle => handle.reads
  const backgroundFailures = new Map()
  const query = new RunQuery(store)
  const reads = new RunReadService({
    store,
    query,
    backgroundFailures,
    decodeDefinition: definitionJson => service.decodeOrThrow(definitionJson),
    teamRuntime: record => service.teamObservations.snapshot(record)
  })
  service.configuredRuntime = async () => ({ store, query, reads, backgroundFailures })
  return { service, store, runId, attempt }
}

for (const backend of ['directory']) {
  test(`W3 C-07/C-09 ${backend}: native member reads its canonical Run and original stage Attempt without changing facts`, async t => {
    const h = await fixture(t, backend),
      before = await h.store.get(h.runId)
    const value = await h.service.inspectSession({ sessionId: 'member-session', runId: h.runId })
    assert.equal(value.status, 'bound')
    assert.equal(value.selected.run.runId, h.runId)
    assert.equal(value.selected.source.sessionId, 'lead-session')
    assert.equal(value.selected.run.team.leadSessionId, 'lead-session')
    assert.deepEqual(value.selected.focusAttemptIds, [h.attempt.attemptId])
    assert.deepEqual(await h.store.get(h.runId), before)
  })
  test(`W3 C-08/C-09 ${backend}: native names confer no membership and unrelated Sessions remain unbound`, async t => {
    const h = await fixture(t, backend)
    for (const sessionId of ['native-primary', 'primary', 'foreign-session']) {
      assert.deepEqual(await h.service.inspectSession({ sessionId }), { status: 'unbound', sessionId })
      await assert.rejects(h.service.inspectSession({ sessionId, runId: h.runId }), { code: 'blueprint/run-not-found' })
      assert.deepEqual(focusAttemptsForSession(await h.store.get(h.runId), sessionId), [])
    }
    const lead = await h.service.inspectSession({ sessionId: 'lead-session' })
    assert.equal(lead.status, 'bound')
    assert.equal(lead.selected.run.team.teamId, 'lead-session')
  })
}
