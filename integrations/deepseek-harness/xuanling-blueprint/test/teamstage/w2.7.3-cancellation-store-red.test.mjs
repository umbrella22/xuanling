import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'
import { reconcileOnStart } from '../../src/orchestration/recovery.ts'
import { recordTeamEffectIntent } from '../../src/teamstage/runner.ts'

const digest = value => createHash('sha256').update(value).digest('hex')

async function fixture(t, backend, requestId) {
  const root = await mkdtemp(join(tmpdir(), `xuanling-w2.7.3-${backend}-`))
  const path = backend === 'json' ? join(root, 'store') : join(root, 'store', 'runs.sqlite')
  let opened
  let store

  const open = async () => {
    if (backend === 'json') await mkdir(join(root, 'store'), { recursive: true })
    else await mkdir(join(root, 'store'), { recursive: true })
    opened = await openBlueprintDomain({ backend, path })
    store = new RunStore(opened.domain)
  }
  const close = async () => {
    await opened?.close()
    opened = undefined
  }
  const reopen = async () => {
    await close()
    await open()
  }

  t.after(async () => {
    await close()
    await rm(root, { recursive: true, force: true })
  })
  await open()

  const created = await store.createRun(
    { scope: 'w2-7-3-cancellation-red', requestId, payloadFingerprint: digest(requestId) },
    digest('w2.7.3-definition'),
    '{}',
    '{}'
  )
  const attempt = await store.recordIntent(created.runId, { nodeId: 'work', kind: 'agentTask' })
  await store.bindTeamStage(created.runId, {
    stageId: 'work',
    teamId: 'team-1',
    leadSessionId: 'lead',
    taskSpecificationFingerprint: digest('task'),
    attemptId: attempt.attemptId,
    requiredMemberIds: ['member-1'],
    requiredChecks: ['schema'],
    primaryMemberId: 'member-1'
  })
  await store.bindTeamTask(created.runId, { taskId: 'task-1', taskRevision: 1 })
  await store.updateTeamStage(created.runId, {
    members: [{ memberId: 'member-1', name: 'bp-member-1', sessionId: 'member-session-1', phase: 'active', status: 'running' }]
  })

  return {
    get store() {
      return store
    },
    get opened() {
      return opened
    },
    runId: created.runId,
    attemptId: attempt.attemptId,
    reopen
  }
}

test('W2.7.3 red: requestCancel persists the Team cancelling cutoff and owned facts before effects', async t => {
  const h = await fixture(t, 'json', 'cancel-cutoff')
  const after = await h.store.requestCancel(h.runId)

  assert.deepEqual(
    {
      runState: after.state,
      stageState: after.teamStage?.state,
      attemptState: after.attempts.find(attempt => attempt.attemptId === h.attemptId)?.state,
      cancellationFact: after.teamStage?.cancel !== undefined
    },
    {
      runState: 'cancelling',
      stageState: 'cancelling',
      attemptState: 'cancelling',
      cancellationFact: true
    },
    'cancelRun must durably close the TeamStage cutoff and retain owned cancellation facts before native effects'
  )
})

for (const backend of ['json', 'sqlite']) {
  test(`W2.7.3 red: ${backend} repairs a legacy Run cancelling state without moving the first Team cutoff`, async t => {
    const h = await fixture(t, backend, `legacy-cancelling-${backend}`)
    const legacy = await h.store.transition(h.runId, draft => {
      draft.state = 'cancelling'
      const attempt = draft.attempts.find(candidate => candidate.attemptId === h.attemptId)
      if (attempt !== undefined) attempt.state = 'cancelling'
      // Simulate the old partial record: the Run cutoff exists, but the
      // TeamStage was not durably moved or stamped before the process stopped.
    })
    assert.equal(legacy.state, 'cancelling')
    assert.equal(legacy.teamStage?.state, 'active')
    assert.equal(legacy.teamStage?.cancel, undefined)

    const repaired = await h.store.requestCancel(h.runId, 'repair-cutoff')
    assert.equal(repaired.state, 'cancelling')
    assert.equal(repaired.teamStage?.state, 'cancelling')
    assert.equal(repaired.teamStage?.cancel?.reason, 'repair-cutoff')
    assert.equal(typeof repaired.teamStage?.cancel?.requestedAt, 'number')
    const seq = repaired.seq
    const cutoff = repaired.teamStage.cancel.requestedAt

    const replay = await h.store.requestCancel(h.runId, 'must-not-replace-cutoff')
    assert.equal(replay.seq, seq, 'a complete cancelling cutoff is idempotent')
    assert.equal(replay.teamStage?.cancel?.requestedAt, cutoff)
    assert.equal(replay.teamStage?.cancel?.reason, 'repair-cutoff')
  })
}

for (const backend of ['json', 'sqlite']) {
  test(`W2.7.3 red: ${backend} pending Team effect reopen preserves cancellation cutoff and owned facts`, async t => {
    const h = await fixture(t, backend, `pending-effect-${backend}`)
    await h.store.requestCancel(h.runId)
    await recordTeamEffectIntent(h.store, {
      runId: h.runId,
      stageId: 'work',
      teamId: 'team-1',
      effectId: `spawn-${backend}`,
      kind: 'spawn',
      memberName: 'bp-member-1',
      actorSessionId: 'lead'
    })

    await h.reopen()
    await reconcileOnStart(h.store)
    const recovered = await h.store.get(h.runId)

    assert.equal(recovered.state, 'recovery_required')
    assert.equal(recovered.teamStage?.state, 'recovery_required')
    assert.equal(recovered.attempts.find(attempt => attempt.attemptId === h.attemptId)?.state, 'recovery_required')
    assert.equal(recovered.attempts.find(attempt => attempt.attemptId === h.attemptId)?.result, undefined)
    assert.equal(recovered.teamStage?.effects?.[0]?.state, 'pending')
    assert.equal(typeof recovered.teamStage?.cancel?.requestedAt, 'number', 'reopen must retain the cancellation cutoff')
    assert.deepEqual(recovered.teamStage?.requiredMemberIds, ['member-1'], 'reopen must retain the server-owned member set')
    assert.deepEqual(
      recovered.teamStage?.members.map(member => ({ memberId: member.memberId, sessionId: member.sessionId })),
      [{ memberId: 'member-1', sessionId: 'member-session-1' }],
      'reopen must retain the canonical member identity facts'
    )

    await h.reopen()
    assert.deepEqual(await h.store.get(h.runId), recovered, 'a second real backend reopen must be read-only after the recovery barrier')
  })
}
