import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'
import { acceptTeamOutput } from '../../src/teamstage/acceptance.ts'
import { recordTeamEffectIntent } from '../../src/teamstage/runner.ts'
import { reconcileOnStart } from '../../src/orchestration/recovery.ts'

const digest = value => createHash('sha256').update(value).digest('hex')
async function oldFixture(t, members = [], options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'blueprint-canonical-red-'))
  const opened = await openBlueprintDomain({ backend: 'json', path: join(root, 'store') })
  const store = new RunStore(opened.domain)
  const { runId } = await store.createRun({ scope: 'run', requestId: 'canonical', payloadFingerprint: digest('request') }, 'rev-1', '{}', '{}')
  const attempt = await store.recordIntent(runId, { nodeId: 'work', kind: 'agentTask' })
  await store.bindTeamStage(runId, {
    stageId: 'work',
    teamId: 'lead',
    leadSessionId: 'lead',
    taskSpecificationFingerprint: digest('task'),
    attemptId: attempt.attemptId,
    ...(members.length === 0 || options.omitMemberPolicy === true
      ? {}
      : { requiredMemberIds: members.map(member => member.memberId), primaryMemberId: members[0].memberId })
  })
  await store.bindTeamTask(runId, { taskId: 'task-1', taskRevision: 1 })
  // Synthetic canonical sessions model the settlement boundary only; these
  // fixtures do not prove native child creation or immutable artifact writes.
  const canonicalMembers = members.map(member => ({
    ...member,
    sessionId: member.sessionId ?? `${member.memberId}-session`,
    phase: member.phase ?? 'active',
    status: member.status === 'running' ? 'inactive' : member.status,
    evidence:
      member.phase === 'failed'
        ? undefined
        : {
            runId,
            stageId: 'work',
            taskId: 'task-1',
            attemptId: attempt.attemptId,
            captureId: `capture-${member.memberId}`,
            schemaDigest: digest('schema'),
            valueDigest: digest(`value-${member.memberId}`),
            completedTurnId: `turn-${member.memberId}`,
            flushedAt: 1,
            quiescentAt: 2
          }
  }))
  if (canonicalMembers.length) await store.updateTeamStage(runId, { members: canonicalMembers })
  t.after(async () => {
    await opened.close()
    await rm(root, { recursive: true, force: true })
  })
  const output = {
    code: 'accepted',
    schemaVersion: 1,
    runId,
    stageId: 'work',
    taskId: 'task-1',
    attemptId: attempt.attemptId,
    sourceSessionId: canonicalMembers[0]?.sessionId ?? 'lead',
    artifactId: 'never-created',
    digest: digest('fake bytes'),
    evidenceDigest: digest('fake evidence'),
    checks: ['schema', 'digest', 'artifact-digest', 'agreement']
  }
  const task = { id: 'task-1', revision: 1, status: 'completed' }
  const hostVerdict = {
    status: 'verified',
    artifactId: output.artifactId,
    digest: output.digest,
    byteLength: 20,
    schemaDigest: digest('schema'),
    evidenceDigest: output.evidenceDigest,
    runId,
    stageId: 'work',
    taskId: 'task-1',
    attemptId: attempt.attemptId,
    producerSessionId: output.sourceSessionId,
    producerMemberId: members[0]?.memberId ?? 'lead'
  }
  return { root, store, runId, output, task, attemptId: attempt.attemptId, hostVerdict, outputs: { answer: 'verified-primary' } }
}

test('W2.7.1 C-04 old acceptance must reject a missing host verdict even when client digests agree', async t => {
  const h = await oldFixture(t, [{ memberId: 'primary', phase: 'active', status: 'running' }])
  await assert.rejects(
    acceptTeamOutput({ ...h, hostVerdict: undefined, artifact: { artifactId: h.output.artifactId, digest: h.output.digest } }),
    error => error.issueCode === 'host-verdict-required'
  )
  assert.equal((await h.store.get(h.runId)).teamStage.outputAcceptance, undefined)
})

test('W2.7.1 C-04 old acceptance cannot omit a failed collaborator with an empty client policy', async t => {
  const h = await oldFixture(t, [
    { memberId: 'primary', phase: 'active', status: 'running' },
    { memberId: 'collaborator', phase: 'failed', status: 'failed' }
  ])
  await assert.rejects(
    acceptTeamOutput({ ...h, requiredMemberIds: [], requiredChecks: ['schema'] }),
    error => error.issueCode === 'required-member-policy-override'
  )
  assert.notEqual((await h.store.get(h.runId)).teamStage.state, 'succeeded')
})

test('W2.7.1 C-04 host verdict producer must belong to the canonical required member set', async t => {
  const h = await oldFixture(t, [{ memberId: 'primary', phase: 'active', status: 'running' }], { omitMemberPolicy: true })
  await assert.rejects(
    acceptTeamOutput({ ...h, hostVerdict: { ...h.hostVerdict, producerMemberId: 'foreign-member' } }),
    error => error.issueCode === 'producer-policy-mismatch'
  )
  assert.equal((await h.store.get(h.runId)).teamStage.outputAcceptance, undefined)
})

test('W2.7.1 C-02/C-04 accepting a stage settles the original graph Attempt and its output', async t => {
  const h = await oldFixture(t, [{ memberId: 'primary', phase: 'active', status: 'running' }])
  const settled = await acceptTeamOutput(h)
  assert.equal(settled.teamStage.state, 'succeeded')
  assert.equal(settled.attempts.find(a => a.attemptId === h.attemptId).state, 'succeeded', 'stage success must settle the same durable Attempt')
  assert.ok(settled.attempts[0].result?.outcome.outputs, 'the original Attempt owns downstream output')
})

test('W2.7.1 C-04 pending Team effect cannot settle the stage or graph Attempt', async t => {
  const h = await oldFixture(t, [{ memberId: 'primary', phase: 'active', status: 'running' }])
  await recordTeamEffectIntent(h.store, {
    runId: h.runId,
    stageId: 'work',
    teamId: 'lead',
    actorSessionId: 'lead',
    effectId: 'pending-before-accept',
    kind: 'spawn',
    memberName: 'bp-reserved'
  })
  await assert.rejects(acceptTeamOutput(h), error => error.issueCode === 'pending-team-effect')
  const current = await h.store.get(h.runId)
  assert.equal(current.teamStage.state, 'active')
  assert.equal(current.teamStage.outputAcceptance, undefined)
  assert.equal(current.attempts.find(a => a.attemptId === h.attemptId).result, undefined)
})

test('W2.7.1 C-04 parent Run cancellation cutoff wins an acceptance race', async t => {
  const h = await oldFixture(t, [{ memberId: 'primary', phase: 'active', status: 'running' }])
  await h.store.requestCancel(h.runId)
  await assert.rejects(acceptTeamOutput(h), error => error.issueCode === 'run-not-accepting')
  const current = await h.store.get(h.runId)
  assert.equal(current.state, 'cancelling')
  assert.equal(current.teamStage.state, 'cancelling')
  assert.equal(current.teamStage.cancel !== undefined, true)
  assert.equal(current.attempts.find(a => a.attemptId === h.attemptId).state, 'cancelling')
  assert.equal(current.teamStage.outputAcceptance, undefined)
  assert.equal(current.attempts.find(a => a.attemptId === h.attemptId).result, undefined)
})

test('W2.7.1 C-04 cancellation cutoff during settlement remains a typed rejection until coordinator drain', async t => {
  const h = await oldFixture(t, [{ memberId: 'primary', phase: 'active', status: 'running' }])
  await h.store.transition(h.runId, draft => {
    draft.state = 'waiting_input'
    draft.attempts.find(attempt => attempt.attemptId === h.attemptId).state = 'waiting_input'
  })
  const settle = h.store.settleTeamStageAttempt.bind(h.store)
  h.store.settleTeamStageAttempt = async (...args) => {
    await h.store.requestCancel(h.runId)
    return await settle(...args)
  }
  try {
    await assert.rejects(acceptTeamOutput(h), error => error.issueCode === 'run-not-accepting')
  } finally {
    h.store.settleTeamStageAttempt = settle
  }
  const current = await h.store.get(h.runId)
  assert.equal(current.state, 'cancelling')
  assert.equal(current.teamStage.state, 'cancelling')
  assert.equal(current.teamStage.cancel !== undefined, true)
  assert.equal(current.attempts.find(a => a.attemptId === h.attemptId).state, 'cancelling')
})

test('W2.7.1 C-06 Team-only pending intent in waiting_input survives log rotation and requires recovery on reopen', async t => {
  const h = await oldFixture(t)
  await recordTeamEffectIntent(h.store, {
    runId: h.runId,
    stageId: 'work',
    teamId: 'lead',
    actorSessionId: 'lead',
    effectId: 'spawn-pending',
    kind: 'spawn',
    memberName: 'bp-reserved'
  })
  for (let i = 0; i < 205; i++)
    await h.store.transition(h.runId, draft => {
      draft.log.push({ seq: draft.seq + 1, at: 1, kind: 'state', detail: { padding: i } })
    })
  await h.store.transition(h.runId, draft => {
    draft.state = 'waiting_input'
  })
  assert.equal(
    (await h.store.get(h.runId)).log.some(e => e.detail.effectId === 'spawn-pending'),
    false,
    'the oracle relies on canonical effects, not retained audit entries'
  )
  await reconcileOnStart(h.store)
  const recovered = await h.store.get(h.runId)
  assert.equal(recovered.state, 'recovery_required')
  assert.equal(recovered.teamStage.state, 'recovery_required')
  assert.equal(recovered.teamStage.effects[0].state, 'pending', 'unknown outcome must not be fabricated as a settled effect')
})
