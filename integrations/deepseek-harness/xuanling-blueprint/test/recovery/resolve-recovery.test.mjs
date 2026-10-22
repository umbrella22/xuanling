import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { BlueprintService } from '../../src/index.ts'
import { openBlueprintDomain, RunStore, TeamStageConflictError } from '../../src/persistence/index.ts'
import { reconcile, reconcileOnStart } from '../../src/orchestration/index.ts'
import { fixture } from '../feedback-fixtures.mjs'

const request = id => ({ scope: 'run', requestId: id, payloadFingerprint: `fp:${id}` })

async function seedRecoveryRun(runtimeRoot, id) {
  const opened = await openBlueprintDomain({ path: runtimeRoot })
  try {
    const store = new RunStore(opened.domain)
    const { runId } = await store.createRun(request(id), 'frozen-revision', '{}', '{}')
    await store.recordIntent(runId, { nodeId: 'work', kind: 'agentTask' })
    await reconcileOnStart(store)
    const record = await store.get(runId)
    assert.equal(record.state, 'recovery_required')
    return { runId, seq: record.seq }
  } finally {
    await opened.close()
  }
}

async function service(t, runtimeRoot) {
  const ctx = new Context()
  const fiber = await ctx.plugin(BlueprintService, { runtimeRoot })
  t.after(async () => {
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
  return ctx.blueprint
}

test('resolveRecovery moves a recovery_required Run to the reviewed terminal once, with an operator audit entry and no replay', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bp-resolve-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const runtimeRoot = join(root, 'runtime')
  mkdirSync(runtimeRoot, { recursive: true })
  const { runId, seq } = await seedRecoveryRun(runtimeRoot, 'resolve')
  const blueprint = await service(t, runtimeRoot)

  await assert.rejects(blueprint.resolveRecovery({ runId, resolution: 'failed', note: 'checked', expectedSeq: seq - 1 }), {
    code: 'blueprint/run-lifecycle-conflict'
  })
  await assert.rejects(blueprint.resolveRecovery({ runId, resolution: 'failed', note: '   ', expectedSeq: seq }), { code: 'blueprint/run-lifecycle-conflict' })
  await assert.rejects(blueprint.resolveRecovery({ runId, resolution: 'retry', note: 'x', expectedSeq: seq }), { code: 'gateway/bad-request' })

  const resolved = await blueprint.resolveRecovery({ runId, resolution: 'failed', note: 'session shows no file was written', expectedSeq: seq })
  assert.deepEqual({ state: resolved.state, applied: resolved.applied }, { state: 'failed', applied: true })
  const snapshot = await blueprint.inspectRun({ runId })
  assert.equal(snapshot.state, 'failed')
  assert.equal(snapshot.attempts.length, 1, 'the unknown effect is settled, never re-dispatched')
  assert.equal(snapshot.attempts[0].state, 'failed')

  const replay = await blueprint.resolveRecovery({ runId, resolution: 'failed', note: 'session shows no file was written', expectedSeq: seq })
  assert.deepEqual({ state: replay.state, applied: replay.applied, seq: replay.seq }, { state: 'failed', applied: false, seq: resolved.seq })
  await assert.rejects(blueprint.resolveRecovery({ runId, resolution: 'succeeded', note: 'changed my mind', expectedSeq: resolved.seq }), {
    code: 'blueprint/run-lifecycle-conflict'
  })

  const report = await blueprint.workflowReport({ runId })
  assert.equal(report.outcome, 'failed')
  assert.deepEqual(report.recovery, { reason: 'intent-without-result', resolvedAs: 'failed', note: 'session shows no file was written' })
})

test('concurrent duplicate resolveRecovery applies once and replays the duplicate', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bp-resolve-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const runtimeRoot = join(root, 'runtime')
  mkdirSync(runtimeRoot, { recursive: true })
  const { runId, seq } = await seedRecoveryRun(runtimeRoot, 'resolve-race')
  const blueprint = await service(t, runtimeRoot)
  const args = { runId, resolution: 'failed', note: 'reviewed once', expectedSeq: seq }
  const results = await Promise.all([blueprint.resolveRecovery(args), blueprint.resolveRecovery(args)])
  assert.equal(results.filter(result => result.applied).length, 1, 'exactly one duplicate resolution applies')
  assert.equal(results.filter(result => !result.applied).length, 1, 'the duplicate is an idempotent replay, not an error')
  assert.ok(results.every(result => result.state === 'failed'))
  const snapshot = await blueprint.inspectRun({ runId })
  assert.equal(snapshot.state, 'failed')
})

test('resolveRecovery rejects an unsettled TeamStage from the pre-read with a manual-cleanup conflict', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bp-resolve-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const runtimeRoot = join(root, 'runtime')
  mkdirSync(runtimeRoot, { recursive: true })
  const opened = await openBlueprintDomain({ path: runtimeRoot })
  let runId, seq
  try {
    const store = new RunStore(opened.domain)
    ;({ runId } = await store.createRun(request('team-guard'), 'frozen-revision', '{}', '{}'))
    const attempt = await store.recordIntent(runId, { nodeId: 'team-stage', kind: 'agentTask' })
    await store.bindTeamStage(runId, {
      stageId: 'team-stage',
      teamId: 'team-1',
      leadSessionId: 'lead-session',
      taskSpecificationFingerprint: 'a'.repeat(64),
      attemptId: attempt.attemptId
    })
    await store.updateTeamStage(runId, { state: 'active' })
    await store.settleTerminal(runId, 'recovery_required', { reason: 'team-effect-unknown' })
    seq = (await store.get(runId)).seq
  } finally {
    await opened.close()
  }
  const blueprint = await service(t, runtimeRoot)
  await assert.rejects(
    blueprint.resolveRecovery({ runId, resolution: 'failed', note: 'assumed no teammate ran', expectedSeq: seq }),
    error => error.code === 'blueprint/run-lifecycle-conflict' && error.details?.detail === 'teamstage-recovery-manual',
    'the pre-read refuses a Run whose TeamStage is not settled'
  )
})

test("reconcile's CAS guard rejects a TeamStage that moved after the reviewed cut", async t => {
  const root = mkdtempSync(join(tmpdir(), 'bp-resolve-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const runtimeRoot = join(root, 'runtime')
  mkdirSync(runtimeRoot, { recursive: true })
  // The Host pre-read cannot observe a TeamStage that moves between the reviewed
  // snapshot and the store transition, so exercise the in-transition guard directly.
  const opened = await openBlueprintDomain({ path: runtimeRoot })
  try {
    const store = new RunStore(opened.domain)
    const { runId } = await store.createRun(request('team-cas'), 'frozen-revision', '{}', '{}')
    const attempt = await store.recordIntent(runId, { nodeId: 'team-stage', kind: 'agentTask' })
    await store.bindTeamStage(runId, {
      stageId: 'team-stage',
      teamId: 'team-1',
      leadSessionId: 'lead-session',
      taskSpecificationFingerprint: 'a'.repeat(64),
      attemptId: attempt.attemptId
    })
    await store.updateTeamStage(runId, { state: 'active' })
    await store.settleTerminal(runId, 'recovery_required', { reason: 'team-effect-unknown' })
    const reviewed = await store.get(runId)
    let guard
    try {
      await reconcile(store, reviewed, 'failed', 'assumed no teammate ran', { expectedSeq: reviewed.seq, guardTeamStage: true, operator: true })
    } catch (error) {
      guard = error
    }
    assert.ok(guard instanceof TeamStageConflictError, 'the transition itself must refuse an unsettled TeamStage')
    assert.equal((await store.get(runId)).state, 'recovery_required', 'the refused transition writes nothing')
    // Once the native Team is settled, the same reviewed action succeeds.
    await store.updateTeamStage(runId, { state: 'failed' })
    const settled = await store.get(runId)
    const after = await reconcile(store, settled, 'failed', 'team cleaned up', { expectedSeq: settled.seq, guardTeamStage: true, operator: true })
    assert.equal(after.state, 'failed')
    assert.equal(after.log.at(-1).detail.actor, 'operator')
  } finally {
    await opened.close()
  }
})

test('resolveRecovery follows the caller Workspace when sessionId is provided', async t => {
  const f = await fixture(t, { emptyConfig: true })
  const other = join(f.root, 'other')
  mkdirSync(join(other, '.xuanling'), { recursive: true })
  f.ctx.provide('workspaceRegistry', {
    list: () => [
      { path: join(f.root, 'workspace'), sessionIds: [] },
      { path: other, sessionIds: ['feedback-session'] }
    ]
  })
  const { runId, seq } = await seedRecoveryRun(join(other, '.xuanling'), 'scoped-resolve')
  const blueprint = f.ctx.blueprint

  await assert.rejects(blueprint.resolveRecovery({ runId, resolution: 'failed', note: 'checked', expectedSeq: seq }), {
    code: 'blueprint/run-not-found'
  })
  const resolved = await blueprint.resolveRecovery({ runId, sessionId: 'feedback-session', resolution: 'failed', note: 'checked', expectedSeq: seq })
  assert.deepEqual({ state: resolved.state, applied: resolved.applied }, { state: 'failed', applied: true })
})

test('resolveRecovery rejects Runs that are not waiting for recovery', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bp-resolve-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const runtimeRoot = join(root, 'runtime')
  mkdirSync(runtimeRoot, { recursive: true })
  const opened = await openBlueprintDomain({ path: runtimeRoot })
  let runId
  try {
    const store = new RunStore(opened.domain)
    ;({ runId } = await store.createRun(request('terminal'), 'frozen-revision', '{}', '{}'))
    await store.settleTerminal(runId, 'failed', { reason: 'prepare-failed' })
  } finally {
    await opened.close()
  }
  const blueprint = await service(t, runtimeRoot)
  await assert.rejects(blueprint.resolveRecovery({ runId, resolution: 'failed', note: 'x', expectedSeq: 0 }), { code: 'blueprint/run-lifecycle-conflict' })
  await assert.rejects(blueprint.resolveRecovery({ runId: 'missing-run', resolution: 'failed', note: 'x', expectedSeq: 0 }), {
    code: 'blueprint/run-not-found'
  })
})
