import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'

async function fixture(t, _backend = 'directory') {
  const root = await mkdtemp(join(tmpdir(), 'blueprint-native-observation-'))
  const path = join(root, 'store')
  let opened = await openBlueprintDomain({ path })
  const store = new RunStore(opened.domain)
  const { runId } = await store.createRun({ scope: 'observation', requestId: 'run', payloadFingerprint: 'a'.repeat(64) }, 'revision', '{}', '{}')
  await store.bindTeamStage(runId, { stageId: 'stage', teamId: 'team', leadSessionId: 'lead', taskSpecificationFingerprint: 'b'.repeat(64) })
  await store.bindTeamTask(runId, { taskId: 'task', taskRevision: 1 })
  t.after(async () => {
    await opened.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    store,
    runId,
    async reopen() {
      await opened.close()
      opened = await openBlueprintDomain({ path })
      return new RunStore(opened.domain)
    }
  }
}

test('W2.6 C-02 native observations may skip revisions while Blueprint mutations retain strict one-step CAS', async t => {
  const { store, runId } = await fixture(t)
  await assert.rejects(store.updateTeamTaskRevision(runId, 1, 3), error => error.code === 'TEAM_TASK_CONFLICT')
  const before = await store.get(runId)
  const observed = await store.observeTeamTaskRevision(runId, { taskId: 'task', taskRevision: 3 }, 1)
  assert.equal(observed.teamStage.taskRevision, 3)
  assert.equal(observed.log.length, before.log.length + 1, 'one observation does not invent intermediate native transitions')
  assert.equal(observed.log.at(-1).detail.teamStage, 'task-observed')
  assert.deepEqual(await store.observeTeamTaskRevision(runId, { taskId: 'task', taskRevision: 3 }, 3), observed)
})

test('W2.6 C-02/C-05 native observations reject foreign, stale, backwards and terminal updates without changing durable facts', async t => {
  const { store, runId } = await fixture(t)
  const current = await store.observeTeamTaskRevision(runId, { taskId: 'task', taskRevision: 3 }, 1)
  for (const [task, expected] of [
    [{ taskId: 'foreign', taskRevision: 4 }, 3],
    [{ taskId: 'task', taskRevision: 4 }, 1],
    [{ taskId: 'task', taskRevision: 2 }, 3]
  ]) {
    await assert.rejects(store.observeTeamTaskRevision(runId, task, expected), error => error.code === 'TEAM_TASK_CONFLICT')
    assert.deepEqual(await store.get(runId), current)
  }
  await store.updateTeamStage(runId, { state: 'cancelling' })
  await store.updateTeamStage(runId, { state: 'cancelled' })
  const cancelled = await store.get(runId)
  await assert.rejects(store.observeTeamTaskRevision(runId, { taskId: 'task', taskRevision: 4 }, 3), error => error.code === 'TEAM_TASK_CONFLICT')
  assert.deepEqual(await store.get(runId), cancelled)
})

for (const backend of ['directory']) {
  test(`W2.6 C-02/C-06 ${backend} native observation survives reopen and concurrent stale writers cannot overwrite it`, async t => {
    const { store, runId, reopen } = await fixture(t, backend)
    const writers = await Promise.allSettled([
      store.observeTeamTaskRevision(runId, { taskId: 'task', taskRevision: 3 }, 1),
      store.observeTeamTaskRevision(runId, { taskId: 'task', taskRevision: 4 }, 1)
    ])
    assert.equal(writers.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(writers.filter(result => result.status === 'rejected' && result.reason.code === 'TEAM_TASK_CONFLICT').length, 1)
    const observed = await store.get(runId)
    assert.equal(observed.log.filter(entry => entry.detail?.teamStage === 'task-observed').length, 1)
    const restored = await reopen()
    assert.deepEqual(await restored.get(runId), observed)
    const replay = await restored.observeTeamTaskRevision(
      runId,
      { taskId: 'task', taskRevision: observed.teamStage.taskRevision },
      observed.teamStage.taskRevision
    )
    assert.deepEqual(replay, observed, 'replaying an observation after restart adds no fact or mutation')
  })

  test(`W2.6 C-05 ${backend} cancellation queued before an observation prevents any late revision fact`, async t => {
    const { store, runId } = await fixture(t, backend)
    const outcomes = await Promise.allSettled([
      store.updateTeamStage(runId, { state: 'cancelling' }),
      store.observeTeamTaskRevision(runId, { taskId: 'task', taskRevision: 3 }, 1)
    ])
    assert.equal(outcomes[0].status, 'fulfilled')
    assert.equal(outcomes[1].status, 'rejected')
    assert.equal(outcomes[1].reason.code, 'TEAM_TASK_CONFLICT')
    const current = await store.get(runId)
    assert.equal(current.teamStage.state, 'cancelling')
    assert.equal(current.teamStage.taskRevision, 1)
    assert.equal(current.log.filter(entry => entry.detail?.teamStage === 'task-observed').length, 0)
  })
}
