import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBlueprintDomain, RunStore, createBackup, restoreBackup } from '../../src/persistence/index.ts'
import { reconcileOnStart } from '../../src/orchestration/recovery.ts'
import { TeamDriverError } from '../../src/teamstage/driver-admission.ts'
import { teamStageControl, TeamStageObservations } from '../../src/teamstage/observability.ts'
import { teamStageExecutionCodec } from '../../src/host/teamstage-diagnostics.ts'
import { projectRunSnapshot } from '../../src/conversation/run-projection.ts'

const digest = value => createHash('sha256').update(value).digest('hex')
const execution = { startedAt: 100 }

test('the first caller or stage-control abort keeps its typed source and drops raw reasons', () => {
  for (const [first, source, code] of [[0, 'caller', 'teamstage-cancelled'], [1, 'stage_control', 'teamstage-team-effect-unknown']]) {
    const inputs = Array.from({ length: 3 }, () => new AbortController())
    let time = 100
    const control = teamStageControl(inputs[0].signal, inputs[1].signal, undefined, () => time++)
    inputs[first].abort(first === 1 ? new TeamDriverError(code) : new Error('RAW_ABORT_REASON_SENTINEL'))
    const original = control.snapshot()
    for (const input of inputs) input.abort(new Error('LATE_ABORT_REASON_SENTINEL'))
    assert.deepEqual(control.snapshot(), original, 'a later abort must not replace the first fact')
    assert.deepEqual(original.abort, { source, code, occurredAt: 101 })
    assert.equal(control.signal.reason.issueCode, code)
    assert.equal(JSON.stringify(original).includes('SENTINEL'), false)
    control.dispose()
  }
  const parent = new AbortController(), stage = new AbortController()
  const control = teamStageControl(parent.signal, stage.signal)
  control.dispose(); parent.abort(new Error('RAW_AFTER_DISPOSE'))
  assert.equal(control.signal.aborted, false, 'disposal releases input listeners')
})

test('an explicit DSH deadline is recorded only when the host supplies one', () => {
  const deadline = new AbortController()
  const control = teamStageControl(new AbortController().signal, new AbortController().signal,
    { signal: deadline.signal, timeoutMs: 45_000 }, () => 100)
  assert.deepEqual(control.snapshot(), { startedAt: 100, deadlineAt: 45_100, timeoutMs: 45_000 })
  deadline.abort(new Error('RAW_TIMEOUT_REASON_SENTINEL'))
  assert.deepEqual(control.snapshot().abort, { source: 'deadline', code: 'teamstage-deadline-exceeded', occurredAt: 100 })
  assert.equal(JSON.stringify(control.snapshot()).includes('SENTINEL'), false)
  control.dispose()
})

test('execution codec rejects inconsistent abort classification and raw payload fields', () => {
  for (const abort of [
    { source: 'deadline', code: 'teamstage-cancelled', occurredAt: 101 },
    { source: 'caller', code: 'teamstage-deadline-exceeded', occurredAt: 101 },
    { source: 'stage_control', code: 'teamstage-deadline-exceeded', occurredAt: 101 },
    { source: 'deadline', code: 'teamstage-deadline-exceeded', occurredAt: 99 },
    { source: 'deadline', code: 'teamstage-deadline-exceeded', occurredAt: 101 },
  ]) assert.equal(teamStageExecutionCodec().safeParse({ ...execution, abort }).success, false)
  assert.equal(teamStageExecutionCodec().safeParse({ startedAt: 100, deadlineAt: 20100 }).success, false)
  assert.equal(teamStageExecutionCodec().safeParse({ startedAt: 100, timeoutMs: 20_000 }).success, false)
  assert.equal(teamStageExecutionCodec().safeParse({ startedAt: 100, deadlineAt: 20100, timeoutMs: 20_000 }).success, true)
  assert.equal(teamStageExecutionCodec().safeParse({ ...execution, reason: 'RAW_REASON' }).success, false)
})

async function fixture(t, backend) {
  const root = await mkdtemp(join(tmpdir(), `bp-observability-${backend}-`))
  const runtime = join(root, 'runtime')
  await mkdir(join(runtime, 'store'), { recursive: true })
  const path = backend === 'json' ? join(runtime, 'store') : join(runtime, 'store/runs.sqlite')
  let opened = await openBlueprintDomain({ backend, path }), store = new RunStore(opened.domain)
  t.after(async () => { await opened?.close(); await rm(root, { recursive: true, force: true }) })
  const { runId } = await store.createRun({ scope: 'observability', requestId: backend, payloadFingerprint: digest(backend) }, digest('definition'), '{}', '{}')
  const { attemptId } = await store.recordIntent(runId, { nodeId: 'work', kind: 'agentTask' })
  await store.bindTeamStage(runId, { stageId: 'work', teamId: 'team', leadSessionId: 'lead', taskSpecificationFingerprint: digest('task'), attemptId })
  await store.bindTeamTask(runId, { taskId: 'task', taskRevision: 1 })
  await store.upsertTeamMember(runId, { memberId: 'member', sessionId: 'child', phase: 'active', status: 'running' })
  return { root, runtime, runId, attemptId, get store() { return store },
    async reopen() { await opened.close(); opened = await openBlueprintDomain({ backend, path }); store = new RunStore(opened.domain) },
    async restore() {
      await opened.close(); opened = undefined
      const backup = createBackup(runtime), restored = join(root, 'restored')
      restoreBackup(backup.archive, restored)
      opened = await openBlueprintDomain({ backend, path: backend === 'json' ? join(restored, 'store') : join(restored, 'store/runs.sqlite') })
      store = new RunStore(opened.domain)
    },
  }
}

for (const backend of ['json', 'sqlite']) {
  test(`${backend}: execution is additive, immutable, idempotent and survives recovery/reopen/backup`, async t => {
    const h = await fixture(t, backend)
    const legacy = await h.store.get(h.runId)
    assert.equal(Object.hasOwn(legacy.teamStage, 'execution'), false)
    await h.reopen()
    const reopenedLegacy = await h.store.get(h.runId)
    assert.equal(Object.hasOwn(reopenedLegacy.teamStage, 'execution'), false, 'legacy records do not synthesize diagnostics')
    const recorded = await h.store.recordTeamStageExecution(h.runId, h.attemptId, execution)
    assert.deepEqual(await h.store.recordTeamStageExecution(h.runId, h.attemptId, execution), recorded, 'identical replay does not write')
    await assert.rejects(() => h.store.recordTeamStageExecution(h.runId, 'foreign-attempt', execution), { code: 'TEAM_STAGE_CONFLICT' })
    await assert.rejects(() => h.store.recordTeamStageExecution(h.runId, h.attemptId, { ...execution, timeoutMs: 21000, deadlineAt: 21100 }), { code: 'TEAM_STAGE_CONFLICT' })
    await h.store.requestCancel(h.runId)
    const aborted = { ...execution, abort: { source: 'caller', code: 'teamstage-cancelled', occurredAt: 150 } }
    await h.store.recordTeamStageExecution(h.runId, h.attemptId, aborted)
    await assert.rejects(() => h.store.recordTeamStageExecution(h.runId, h.attemptId, {
      ...execution, timeoutMs: 20_000, deadlineAt: 20100,
      abort: { source: 'deadline', code: 'teamstage-deadline-exceeded', occurredAt: 20100 },
    }), { code: 'TEAM_STAGE_CONFLICT' })
    await h.reopen(); await reconcileOnStart(h.store)
    const recovered = await h.store.get(h.runId)
    assert.deepEqual(recovered.teamStage.execution, aborted)
    assert.equal(recovered.teamStage.runtime, undefined, 'runtime activity is never durable')
    assert.deepEqual(await h.store.recordTeamStageExecution(h.runId, h.attemptId, aborted), recovered)
    await h.reopen(); await reconcileOnStart(h.store)
    assert.deepEqual(await h.store.get(h.runId), recovered, 'second recovery is read-only')
    await h.restore()
    assert.deepEqual(await h.store.get(h.runId), recovered, 'backup/restore retains exact diagnostic facts')
  })

  test(`${backend}: projection requires the exact original active Attempt and restart never invents thinking`, async t => {
    const h = await fixture(t, backend)
    const observations = new TeamStageObservations()
    observations.begin(h.runId, h.attemptId)
    const member = observations.bind(h.runId, h.attemptId, 'member', 'child')
    member.activity = 'thinking'; member.reasoningDeltas = 2
    const record = await h.store.get(h.runId)
    const runtime = observations.snapshot(record)
    assert.equal(projectRunSnapshot(record, runtime).team.runtime.members[0].activity, 'thinking')
    assert.equal((await h.store.get(h.runId)).seq, record.seq, 'observation reads do not change durable seq')
    for (const mutate of [
      r => r.attempts[0].nodeId = 'foreign-node', r => r.attempts[0].state = 'failed',
      r => r.attempts = [], r => r.state = 'recovery_required', r => r.teamStage.state = 'cancelling',
      r => r.teamStage.members[0].sessionId = 'foreign-session',
    ]) {
      const changed = structuredClone(record); mutate(changed)
      assert.equal(projectRunSnapshot(changed, runtime).team.runtime, undefined, 'foreign/stale/settled binding cannot attach runtime')
    }
    assert.equal(new TeamStageObservations().snapshot(record), undefined, 'restart has no live activity source')
    observations.end(h.runId, h.attemptId)
    assert.equal(observations.snapshot(record), undefined)
  })
}
