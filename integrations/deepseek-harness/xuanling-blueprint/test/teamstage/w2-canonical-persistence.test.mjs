import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackup, openBlueprintDomain, restoreBackup, RunStore } from '../../src/persistence/index.ts'
import { reconcileOnStart } from '../../src/orchestration/recovery.ts'
import { acceptTeamOutput } from '../../src/teamstage/acceptance.ts'
import { recordTeamEffectIntent, recordTeamEffectRecovery, recordTeamEffectResult, TeamEffectReplayError, TeamStageRunner } from '../../src/teamstage/runner.ts'

const digest = value => createHash('sha256').update(value).digest('hex')
const definition = {
  schemaVersion: 2,
  id: 'canonical-persistence',
  name: 'Canonical persistence',
  resources: {
    worker: { kind: 'agent', path: 'lib/agents/worker.md' },
    answer: { kind: 'schema', path: 'lib/schemas/answer.json' }
  },
  graph: {
    nodes: [
      {
        id: 'work',
        kind: 'agentTask',
        agentRef: 'worker',
        outputSchemaRef: 'answer',
        teamStage: {
          task: { subject: 'Produce answer', description: 'Produce and review the same structured answer.' },
          members: [
            { name: 'primary', description: 'Produce output', agentRef: 'worker', context: 'fresh' },
            { name: 'reviewer', description: 'Review output', agentRef: 'worker', context: 'fork' }
          ],
          requiredChecks: ['schema', 'digest', 'artifact-digest', 'agreement']
        }
      }
    ],
    edges: []
  }
}

/** Every reopen closes the actual backend and opens a fresh Cordis context.
 * Backup is taken only while closed and restored into a different directory. */
async function persistence(t, _backend) {
  const root = await mkdtemp(join(tmpdir(), 'blueprint-canonical-persistence-'))
  let runtimeRoot = join(root, 'runtime')
  let opened
  let store
  let restoreNumber = 0
  const open = async () => {
    await mkdir(join(runtimeRoot, 'store'), { recursive: true })
    const path = join(runtimeRoot, 'store')
    opened = await openBlueprintDomain({ path })
    store = new RunStore(opened.domain)
  }
  const close = async () => {
    await opened?.close()
    opened = undefined
  }
  t.after(async () => {
    await close()
    await rm(root, { recursive: true, force: true })
  })
  await open()
  return {
    get store() {
      return store
    },
    async reopen() {
      const previous = opened
      const previousStore = store
      await close()
      await open()
      assert.notEqual(opened.ctx, previous.ctx)
      assert.notEqual(opened.domain, previous.domain)
      assert.notEqual(store, previousStore)
    },
    async backupRestore() {
      const previous = opened
      await close()
      const backup = createBackup(runtimeRoot)
      const files = Object.keys(backup.manifest.files).sort()
      assert.ok(files.length > 0, 'backup contains physical backend files')
      assert.ok(files.every(path => path.startsWith('store/')))
      const restoredRoot = join(root, `restored-${restoreNumber++}`)
      assert.notEqual(restoredRoot, runtimeRoot)
      const restored = restoreBackup(backup.archive, restoredRoot)
      assert.equal(restored.resumed, false)
      assert.deepEqual(restored.filesRestored, files)
      runtimeRoot = restoredRoot
      await open()
      assert.notEqual(opened.ctx, previous.ctx)
      assert.notEqual(opened.domain, previous.domain)
    }
  }
}

async function teamFixture(p, { bound = true, requestId = 'team' } = {}) {
  const { store } = p
  const { runId } = await store.createRun(
    { scope: 'canonical-persistence', requestId, payloadFingerprint: digest(requestId) },
    digest(JSON.stringify(definition)),
    JSON.stringify(definition),
    '{}'
  )
  const attempt = bound ? await store.recordIntent(runId, { nodeId: 'work', kind: 'agentTask' }) : undefined
  await store.bindTeamStage(runId, {
    stageId: 'work',
    teamId: 'lead',
    leadSessionId: 'lead',
    taskSpecificationFingerprint: digest('task'),
    ...(attempt === undefined
      ? {}
      : {
          attemptId: attempt.attemptId,
          requiredMemberIds: ['primary', 'reviewer'],
          primaryMemberId: 'primary',
          requiredChecks: ['schema', 'digest', 'artifact-digest', 'agreement']
        })
  })
  return {
    runId,
    attemptId: attempt?.attemptId,
    facts: { runId, stageId: 'work', teamId: 'lead', actorSessionId: 'lead', effectId: 'reserved-spawn', kind: 'spawn', memberName: 'bp-primary' }
  }
}

async function rotateAndWait(p, h) {
  for (let padding = 0; padding < 205; padding++) {
    await p.store.transition(h.runId, draft => {
      draft.log.push({ seq: draft.seq + 1, at: 1, kind: 'state', detail: { padding } })
    })
  }
  // Waiting for input is an execution state, so move an admission-only
  // queued record through running before applying the waiting transition.
  if ((await p.store.get(h.runId)).state === 'queued') {
    await p.store.transition(h.runId, draft => {
      draft.state = 'running'
    })
  }
  await p.store.transition(h.runId, draft => {
    draft.state = 'waiting_input'
    if (draft.teamStage.state !== 'recovery_required') draft.teamStage.state = 'waiting_input'
    if (h.attemptId !== undefined) draft.attempts.find(attempt => attempt.attemptId === h.attemptId).state = 'waiting_input'
  })
  const before = await p.store.get(h.runId)
  assert.equal(before.log.length, 200)
  assert.equal(
    before.log.some(event => event.detail.effectId === h.facts.effectId),
    false,
    'no effect audit entry remains'
  )
  return before
}

async function assertNoRedispatch(p, h, snapshot, code) {
  let dispatches = 0
  await assert.rejects(
    new TeamStageRunner(p.store).dispatch({
      ...h.facts,
      effect: () => {
        dispatches++
        return { memberId: 'must-not-exist' }
      }
    }),
    error => error.code === code && (code !== 'TEAM_EFFECT_SETTLED' || error instanceof TeamEffectReplayError)
  )
  assert.equal(dispatches, 0, 'unknown external effect is never repeated')
  assert.deepEqual(await p.store.get(h.runId), snapshot, 'replay refusal must not append intent/result or change seq')
}

/** Trusted host fixture for the core settlement contract. Actual artifact
 * byte verification belongs to W2.7.2; acceptance here still runs production
 * policy and atomic settlement rather than writing an accepted record. */
async function acceptFixture(p) {
  const h = await teamFixture(p)
  const task = { id: 'task-1', revision: 1, status: 'completed' }
  const value = { answer: 'verified-primary' }
  const bytes = Buffer.from(JSON.stringify(value))
  const schemaDigest = digest(JSON.stringify({ type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }))
  const create = { ...h.facts, effectId: 'create-task', kind: 'create' }
  delete create.memberName
  await recordTeamEffectIntent(p.store, create)
  await recordTeamEffectResult(p.store, create, { ok: true, taskId: task.id, taskRevision: task.revision, status: task.status })
  await p.store.bindTeamTask(h.runId, { taskId: task.id, taskRevision: task.revision })
  const members = []
  for (const memberId of ['primary', 'reviewer']) {
    const name = `bp-${memberId}`
    const sessionId = `session-${memberId}`
    const spawn = { ...h.facts, effectId: `spawn-${memberId}`, memberName: name }
    await recordTeamEffectIntent(p.store, spawn)
    await recordTeamEffectResult(p.store, spawn, { ok: true, memberId, status: 'inactive' })
    members.push({
      memberId,
      name,
      sessionId,
      phase: 'active',
      status: 'inactive',
      evidence: {
        runId: h.runId,
        stageId: 'work',
        taskId: task.id,
        attemptId: h.attemptId,
        captureId: `capture-${memberId}`,
        schemaDigest,
        valueDigest: digest(bytes),
        completedTurnId: `turn-${memberId}`,
        flushedAt: 2,
        quiescentAt: 3
      }
    })
  }
  await p.store.updateTeamStage(h.runId, { members })
  const output = {
    code: 'accepted',
    schemaVersion: 1,
    runId: h.runId,
    stageId: 'work',
    taskId: task.id,
    attemptId: h.attemptId,
    sourceSessionId: 'session-primary',
    artifactId: 'host-artifact-primary',
    digest: digest(bytes),
    evidenceDigest: digest(JSON.stringify(members.map(member => member.evidence))),
    checks: ['schema', 'digest', 'artifact-digest', 'agreement']
  }
  const hostVerdict = {
    status: 'verified',
    artifactId: output.artifactId,
    digest: output.digest,
    byteLength: bytes.length,
    schemaDigest,
    evidenceDigest: output.evidenceDigest,
    runId: h.runId,
    stageId: 'work',
    taskId: task.id,
    attemptId: h.attemptId,
    producerSessionId: 'session-primary',
    producerMemberId: 'primary'
  }
  const args = { runId: h.runId, attemptId: h.attemptId, output, task, hostVerdict, outputs: { answer: value.answer } }
  const accepted = await acceptTeamOutput({ store: p.store, ...args })
  assert.equal(accepted.teamStage.state, 'succeeded')
  assert.deepEqual(accepted.teamStage.outputAcceptance, output)
  assert.equal(accepted.teamStage.members[0].sessionId, hostVerdict.producerSessionId)
  assert.notEqual(output.sourceSessionId, accepted.teamStage.leadSessionId, 'the producer is the exact captured member, not the submitting Lead')
  assert.equal(accepted.attempts[0].attemptId, h.attemptId)
  assert.equal(accepted.attempts[0].state, 'succeeded')
  assert.deepEqual(accepted.attempts[0].result.outcome.outputs, args.outputs)
  assert.deepEqual(
    accepted.attempts[0].result.outcome.teamVerification,
    {
      definitionRevision: digest(JSON.stringify(definition)),
      taskRevision: task.revision,
      hostVerdict
    },
    'the same durable Attempt retains verified artifact and provenance references'
  )
  assert.equal(accepted.attempts[0].result.seq, accepted.seq, 'stage and graph Attempt settle in the same write')
  return { ...h, args, accepted }
}

for (const backend of ['directory']) {
  test(`W2.7.1 C-06 ${backend} pending Team effect synchronizes the original Attempt after real reopen`, async t => {
    const p = await persistence(t, backend)
    const h = await teamFixture(p)
    await recordTeamEffectIntent(p.store, h.facts)
    const before = await rotateAndWait(p, h)
    await p.reopen()
    assert.deepEqual(await p.store.get(h.runId), before)
    const report = await reconcileOnStart(p.store)
    const recovered = await p.store.get(h.runId)
    assert.equal(recovered.state, 'recovery_required')
    assert.equal(recovered.teamStage.state, 'recovery_required')
    assert.equal(
      recovered.attempts.find(attempt => attempt.attemptId === h.attemptId).state,
      'recovery_required',
      'Team recovery must synchronize the original canonical Attempt'
    )
    assert.equal(recovered.attempts[0].result, undefined, 'unknown outcome is not a settled Attempt result')
    assert.equal(recovered.attempts.length, before.attempts.length, 'recovery never manufactures another Attempt')
    assert.deepEqual(recovered.teamStage.effects, before.teamStage.effects, 'pending effect facts remain unknown')
    assert.equal(recovered.seq, before.seq + 1, 'Run, stage and Attempt enter recovery in one record write')
    assert.deepEqual(report.recoveryRequired, [{ runId: h.runId, attemptId: h.attemptId, nodeId: 'work', intentKind: 'spawn' }])
    await assertNoRedispatch(p, h, recovered, 'TEAM_EFFECT_UNKNOWN')
    await p.reopen()
    assert.deepEqual(await p.store.get(h.runId), recovered)
    assert.deepEqual((await reconcileOnStart(p.store)).untouched, [h.runId])
    assert.deepEqual(await p.store.get(h.runId), recovered, 'second reopen is read-only once the barrier is synchronized')
    await p.backupRestore()
    assert.deepEqual(await p.store.get(h.runId), recovered, 'backup/restore retains the synchronized canonical barrier')
    assert.deepEqual((await reconcileOnStart(p.store)).untouched, [h.runId])
    await assertNoRedispatch(p, h, recovered, 'TEAM_EFFECT_UNKNOWN')
  })

  test(`W2.7.1 C-06 ${backend} recorded unknown Team effect is a waiting_input reopen barrier after audit rotation`, async t => {
    const p = await persistence(t, backend)
    const h = await teamFixture(p)
    await recordTeamEffectIntent(p.store, h.facts)
    await recordTeamEffectRecovery(p.store, h.facts)
    const before = await rotateAndWait(p, h)
    assert.equal(before.teamStage.effects[0].state, 'recovery_required')
    await p.reopen()
    assert.deepEqual(await p.store.get(h.runId), before)
    const report = await reconcileOnStart(p.store)
    const recovered = await p.store.get(h.runId)
    assert.equal(recovered.state, 'recovery_required', 'recorded unknown Team effect must not remain hidden by waiting_input')
    assert.equal(recovered.attempts[0].state, 'recovery_required')
    assert.equal(recovered.attempts[0].result, undefined)
    assert.deepEqual(recovered.teamStage.effects, before.teamStage.effects)
    assert.equal(recovered.seq, before.seq + 1)
    assert.deepEqual(report.recoveryRequired, [{ runId: h.runId, attemptId: h.attemptId, nodeId: 'work', intentKind: 'spawn' }])
    await p.backupRestore()
    assert.deepEqual(await p.store.get(h.runId), recovered)
    assert.deepEqual((await reconcileOnStart(p.store)).untouched, [h.runId])
    await assertNoRedispatch(p, h, recovered, 'TEAM_EFFECT_SETTLED')
  })

  for (const effectState of ['pending', 'recovery_required']) {
    test(`W2.7.1 C-06 ${backend} Team-only ${effectState} survives real reopen and backup without inventing an Attempt`, async t => {
      const p = await persistence(t, backend)
      const h = await teamFixture(p, { bound: false })
      await recordTeamEffectIntent(p.store, h.facts)
      if (effectState === 'recovery_required') await recordTeamEffectRecovery(p.store, h.facts)
      const before = await rotateAndWait(p, h)
      assert.deepEqual(before.attempts, [])
      await p.reopen()
      assert.deepEqual(await p.store.get(h.runId), before)
      const report = await reconcileOnStart(p.store)
      const recovered = await p.store.get(h.runId)
      assert.equal(recovered.state, 'recovery_required')
      assert.equal(recovered.teamStage.state, 'recovery_required')
      assert.deepEqual(recovered.attempts, [])
      assert.deepEqual(recovered.teamStage.effects, before.teamStage.effects)
      assert.equal(recovered.seq, before.seq + 1)
      assert.deepEqual(report.recoveryRequired, [{ runId: h.runId, attemptId: `team:${h.facts.effectId}`, nodeId: 'work', intentKind: 'spawn' }])
      await p.backupRestore()
      assert.deepEqual(await p.store.get(h.runId), recovered)
      assert.deepEqual((await reconcileOnStart(p.store)).untouched, [h.runId])
      await assertNoRedispatch(p, h, recovered, effectState === 'pending' ? 'TEAM_EFFECT_UNKNOWN' : 'TEAM_EFFECT_SETTLED')
    })
  }

  test(`W2.7.1 C-06 ${backend} reopen repairs the prior Run/stage recovery barrier with an unsynchronized original Attempt`, async t => {
    const p = await persistence(t, backend)
    const h = await teamFixture(p)
    await recordTeamEffectIntent(p.store, h.facts)
    // Exact persisted shape produced by the preimage's pendingTeam branch:
    // Run and stage recovered, original graph Attempt still running.
    await p.store.transition(h.runId, draft => {
      draft.state = 'recovery_required'
      draft.teamStage.state = 'recovery_required'
      draft.teamStage.recovery = { code: 'team-effect-unknown', detail: h.facts.effectId }
    })
    const before = await p.store.get(h.runId)
    assert.equal(before.attempts[0].state, 'running')
    await p.reopen()
    assert.deepEqual(await p.store.get(h.runId), before)
    const report = await reconcileOnStart(p.store)
    const repaired = await p.store.get(h.runId)
    assert.equal(repaired.state, 'recovery_required')
    assert.equal(repaired.teamStage.state, 'recovery_required')
    assert.equal(repaired.attempts[0].state, 'recovery_required')
    assert.equal(repaired.attempts[0].result, undefined)
    assert.equal(repaired.seq, before.seq + 1)
    assert.deepEqual(repaired.teamStage.effects, before.teamStage.effects)
    assert.equal(report.recoveryRequired[0].attemptId, h.attemptId)
    await p.backupRestore()
    assert.deepEqual(await p.store.get(h.runId), repaired)
    assert.deepEqual((await reconcileOnStart(p.store)).untouched, [h.runId])
    assert.deepEqual(await p.store.get(h.runId), repaired)
  })

  test(`W2.7.1 C-06 ${backend} concurrent startup scans write one Team recovery fact and report only the writer`, async t => {
    const p = await persistence(t, backend)
    const h = await teamFixture(p)
    await recordTeamEffectIntent(p.store, h.facts)
    const before = await p.store.get(h.runId)
    await p.reopen()
    // Both scanners read the same real reopened record before either writes.
    const get = p.store.get.bind(p.store)
    let reads = 0
    let release
    const bothRead = new Promise(resolve => {
      release = resolve
    })
    p.store.get = async runId => {
      const current = await get(runId)
      if (reads < 2) {
        reads++
        if (reads === 2) release()
        await bothRead
      }
      return current
    }
    let reports
    try {
      reports = await Promise.all([reconcileOnStart(p.store), reconcileOnStart(p.store)])
    } finally {
      p.store.get = get
    }
    assert.equal(reads, 2)
    assert.equal(reports.flatMap(report => report.recoveryRequired).length, 1)
    assert.deepEqual(
      reports.flatMap(report => report.untouched),
      [h.runId]
    )
    const recovered = await p.store.get(h.runId)
    assert.equal(recovered.seq, before.seq + 1)
    assert.equal(recovered.state, 'recovery_required')
    assert.equal(recovered.teamStage.state, 'recovery_required')
    assert.equal(recovered.attempts[0].state, 'recovery_required')
    assert.equal(recovered.log.filter(event => event.detail.reason === 'team-effect-unknown').length, 1)
    assert.deepEqual(recovered.teamStage.effects, before.teamStage.effects)
    await p.backupRestore()
    assert.deepEqual(await p.store.get(h.runId), recovered)
    assert.deepEqual((await reconcileOnStart(p.store)).untouched, [h.runId])
    assert.deepEqual(await p.store.get(h.runId), recovered)
  })

  test(`W2.7.1 C-06 ${backend} create/spawn/message unknown effects in running and cancelling Runs never redispatch after reopen`, async t => {
    const p = await persistence(t, backend)
    const cases = []
    for (const kind of ['create', 'spawn', 'message']) {
      const h = await teamFixture(p, { requestId: kind })
      h.facts = { ...h.facts, effectId: `${kind}-unknown`, kind }
      if (kind !== 'spawn') delete h.facts.memberName
      await recordTeamEffectIntent(p.store, h.facts)
      if (kind === 'message') {
        await recordTeamEffectRecovery(p.store, h.facts)
        await p.store.requestCancel(h.runId)
        assert.equal((await p.store.get(h.runId)).state, 'cancelling')
      }
      cases.push({ h, before: await p.store.get(h.runId) })
    }
    await p.reopen()
    const report = await reconcileOnStart(p.store)
    assert.equal(report.recoveryRequired.length, cases.length)
    for (const { h, before } of cases) {
      const recovered = await p.store.get(h.runId)
      assert.equal(recovered.state, 'recovery_required')
      assert.equal(recovered.teamStage.state, 'recovery_required')
      assert.equal(recovered.attempts[0].state, 'recovery_required')
      assert.equal(recovered.attempts[0].result, undefined)
      assert.deepEqual(recovered.teamStage.effects, before.teamStage.effects)
      assert.equal(recovered.seq, before.seq + 1)
      assert.deepEqual(
        report.recoveryRequired.find(item => item.runId === h.runId),
        { runId: h.runId, attemptId: h.attemptId, nodeId: 'work', intentKind: h.facts.kind }
      )
      await assertNoRedispatch(p, h, recovered, h.facts.kind === 'message' ? 'TEAM_EFFECT_SETTLED' : 'TEAM_EFFECT_UNKNOWN')
    }
    const snapshots = await Promise.all(cases.map(({ h }) => p.store.get(h.runId)))
    await p.backupRestore()
    assert.deepEqual((await reconcileOnStart(p.store)).untouched.sort(), cases.map(({ h }) => h.runId).sort())
    for (const [index, { h }] of cases.entries()) {
      assert.deepEqual(await p.store.get(h.runId), snapshots[index])
      await assertNoRedispatch(p, h, snapshots[index], h.facts.kind === 'message' ? 'TEAM_EFFECT_SETTLED' : 'TEAM_EFFECT_UNKNOWN')
    }
  })

  test(`W2.7.1 C-04/C-06 ${backend} accepted stage and original Attempt reopen read-only, then terminal backup/restore stays read-only`, async t => {
    const p = await persistence(t, backend)
    const h = await acceptFixture(p)
    await p.reopen()
    assert.deepEqual(await p.store.get(h.runId), h.accepted)
    assert.deepEqual((await reconcileOnStart(p.store)).untouched, [h.runId])
    assert.deepEqual(await p.store.get(h.runId), h.accepted)
    assert.deepEqual(await acceptTeamOutput({ store: p.store, ...h.args }), h.accepted, 'acceptance replay after reopen changes no seq or result')
    const terminal = await p.store.settleTerminal(h.runId, 'succeeded', { kind: 'graph-completed' })
    assert.equal(terminal.state, 'succeeded')
    await p.reopen()
    assert.deepEqual(await p.store.get(h.runId), terminal)
    assert.deepEqual((await reconcileOnStart(p.store)).untouched, [h.runId])
    assert.deepEqual(await p.store.get(h.runId), terminal)
    await p.backupRestore()
    assert.deepEqual(await p.store.get(h.runId), terminal)
    assert.deepEqual((await reconcileOnStart(p.store)).untouched, [h.runId])
    assert.deepEqual(await acceptTeamOutput({ store: p.store, ...h.args }), terminal)
    assert.deepEqual(await p.store.get(h.runId), terminal, 'verified terminal stage, artifact refs and Attempt remain exact canonical facts')
    await p.reopen()
    assert.deepEqual(await p.store.get(h.runId), terminal)
  })

  test(`W2.7.1 C-06 ${backend} ordinary waiting_input and terminal Runs keep their legacy reopen/backup semantics`, async t => {
    const p = await persistence(t, backend)
    const legacyDefinition = structuredClone(definition)
    delete legacyDefinition.graph.nodes[0].teamStage
    const makeRun = async requestId =>
      await p.store.createRun(
        { scope: 'ordinary', requestId, payloadFingerprint: digest(requestId) },
        'legacy-revision',
        JSON.stringify(legacyDefinition),
        '{}'
      )
    const { runId: waitingId } = await makeRun('waiting')
    const waitingAttempt = await p.store.recordIntent(waitingId, { nodeId: 'work', kind: 'agentTask' })
    await p.store.transition(waitingId, draft => {
      draft.state = 'waiting_input'
      draft.attempts[0].state = 'waiting_input'
    })
    const waiting = await p.store.get(waitingId)
    const { runId: unknownId } = await makeRun('unknown')
    const unknownAttempt = await p.store.recordIntent(unknownId, { nodeId: 'work', kind: 'agentTask' })
    const { runId: terminalId } = await makeRun('terminal')
    const terminalAttempt = await p.store.recordIntent(terminalId, { nodeId: 'work', kind: 'agentTask' })
    await p.store.recordResult(terminalId, terminalAttempt.attemptId, {
      ok: true,
      outcome: { kind: 'succeeded', outputs: { answer: 'legacy' } },
      evidence: 'known-result'
    })
    const terminal = await p.store.settleTerminal(terminalId, 'succeeded')
    await p.reopen()
    const report = await reconcileOnStart(p.store)
    assert.deepEqual(report.untouched.sort(), [waitingId, terminalId].sort())
    assert.deepEqual(report.recoveryRequired, [{ runId: unknownId, attemptId: unknownAttempt.attemptId, nodeId: 'work', intentKind: 'agentTask' }])
    assert.deepEqual(await p.store.get(waitingId), waiting)
    assert.deepEqual(await p.store.get(terminalId), terminal)
    const recovered = await p.store.get(unknownId)
    assert.equal(recovered.state, 'recovery_required')
    assert.equal(recovered.attempts[0].state, 'recovery_required')
    assert.equal(recovered.attempts[0].result, undefined)
    assert.equal(waiting.attempts[0].attemptId, waitingAttempt.attemptId)
    for (const record of [waiting, terminal, recovered]) assert.equal(Object.hasOwn(record, 'teamStage'), false)
    await p.backupRestore()
    assert.deepEqual((await reconcileOnStart(p.store)).untouched.sort(), [waitingId, terminalId, unknownId].sort())
    assert.deepEqual(await p.store.get(waitingId), waiting)
    assert.deepEqual(await p.store.get(terminalId), terminal)
    assert.deepEqual(await p.store.get(unknownId), recovered)
  })
}
