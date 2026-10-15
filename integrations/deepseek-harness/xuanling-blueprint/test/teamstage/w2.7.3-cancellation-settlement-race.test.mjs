import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BlueprintService } from '../../src/index.ts'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'
import { reconcileOnStart } from '../../src/orchestration/recovery.ts'
import { TeamStageDriver } from '../../src/teamstage/driver.ts'
import { TeamDriverError } from '../../src/teamstage/driver-admission.ts'
import { recordTeamEffectIntent, recordTeamEffectResult } from '../../src/teamstage/runner.ts'
import { definition, agentNode, agentResources } from '../runtime-contracts/agent-fixtures.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')

for (const backend of ['json', 'sqlite']) {
  test(`W2.7.3 scheduler cancellation catch must join successful coordinator settlement ${backend}`, async t => {
    const root = await mkdtemp(join(tmpdir(), `blueprint-cancel-settlement-${backend}-`))
    await mkdir(join(root, 'store'))
    const path = backend === 'json' ? join(root, 'store') : join(root, 'store/runs.sqlite')
    let opened = await openBlueprintDomain({ backend, path })
    t.after(async () => {
      await opened.close()
      await rm(root, { recursive: true, force: true })
    })
    const store = new RunStore(opened.domain)
    const driverEntered = Promise.withResolvers(),
      drainEntered = Promise.withResolvers(),
      releaseDrain = Promise.withResolvers()
    const schedulerDisposition = Promise.withResolvers()
    t.after(() => releaseDrain.resolve())
    const lead = { id: 'lead-session', session: { id: 'lead-session', header: { origin: 'root' } } }
    const member = { memberId: 'member-owned', name: 'owned-child', sessionId: 'child-session', phase: 'active', status: 'running' }
    const task = { id: 'task-owned', revision: 2, status: 'in_progress' }
    const calls = { interrupts: [], drains: [], deletes: [], drivers: 0 }
    const team = {
      membership(agent) {
        assert.equal(agent, lead)
        return { root: lead, id: 'team-owned', role: 'lead', name: 'lead' }
      },
      listMembers() {
        return [{ id: member.sessionId, name: member.name, role: 'teammate', status: member.status }]
      },
      spawnTeammate() {
        throw new Error('UNEXPECTED_NATIVE_SPAWN')
      },
      sendMessage() {
        throw new Error('UNEXPECTED_NATIVE_MESSAGE')
      },
      createTask() {
        throw new Error('UNEXPECTED_NATIVE_CREATE')
      },
      getTask(_agent, id) {
        assert.equal(id, task.id)
        return structuredClone(task)
      },
      listTasks() {
        return [structuredClone(task)]
      },
      async updateTask(agent, request) {
        assert.equal(agent, lead)
        assert.deepEqual(request, { taskId: task.id, expectedRevision: 2, action: 'delete' })
        assert.equal(task.revision, request.expectedRevision)
        calls.deletes.push(structuredClone(request))
        task.revision = 3
        task.status = 'deleted'
        return structuredClone(task)
      },
      async waitForChange() {
        return { timedOut: true }
      },
      interrupt(agent, name) {
        assert.equal(agent, lead)
        calls.interrupts.push(name)
        return { previousStatus: 'running' }
      }
    }
    const values = new Map([
      ['agents', { get: id => (id === lead.id ? lead : undefined) }],
      ['agentTeams', team],
      ['tools', { get: () => undefined }],
      [
        'subagents',
        {
          async drainChildren(agent, ids) {
            assert.equal(agent, lead)
            assert.deepEqual(ids, [member.sessionId])
            calls.drains.push([...ids])
            drainEntered.resolve()
            await releaseDrain.promise
            member.status = 'inactive'
          }
        }
      ]
    ])
    const service = Object.create(BlueprintService.prototype)
    service.ctx = { get: key => values.get(key) }
    service.config = {}
    service.closing = false
    service.checkArgs = () => {}
    const handle = {
      store,
      root,
      controllers: new Map(),
      cancellationTails: new Map(),
      snapshots: {
        async prepareTeam() {
          return { resourceDigests: {}, materialize: () => root }
        }
      }
    }
    service.configuredRuntime = async () => handle
    // Observe both old erroneous disposition and a corrected coordinator join
    // without sleep, timing assumptions or forcing either production branch.
    const updateStage = store.updateTeamStage.bind(store)
    t.mock.method(store, 'updateTeamStage', async (...args) => {
      const result = await updateStage(...args)
      if (args[1].state === 'recovery_required') schedulerDisposition.resolve('stage-recovery-write')
      return result
    })
    const cancelTeam = service.cancelTeamRun
    t.mock.method(service, 'cancelTeamRun', function (...args) {
      if (handle.cancellationTails.has(args[1].runId)) schedulerDisposition.resolve('coordinator-join')
      return cancelTeam.apply(this, args)
    })
    const graph = definition(
      [
        agentNode({
          outputSchemaRef: 'answerSchema',
          outputs: { object: 'json' },
          teamStage: {
            task: { subject: 'Cancel exact task', description: 'Hold until coordinator drains this child.' },
            members: [{ name: 'producer', description: 'Primary', agentRef: 'worker', context: 'fresh' }],
            requiredChecks: ['schema']
          }
        }),
        { id: 'sink', kind: 'output', inputs: { object: 'json' } }
      ],
      { ...agentResources, answerSchema: { kind: 'schema', path: 'lib/schemas/answer.json' } },
      [{ kind: 'data', from: 'work.object', to: 'sink.object' }]
    )
    const { runId } = await store.createRun(
      { scope: 'cancel-settlement', requestId: backend, payloadFingerprint: digest(root) },
      digest(JSON.stringify(graph)),
      JSON.stringify(graph),
      '{}',
      { source: { sessionId: lead.id, kind: 'ui' } }
    )
    // Script only the upstream native execution boundary. The actual scheduler
    // records the Attempt and catches the exact typed abort; public cancelRun,
    // owned cancellation and both storage domains remain production code.
    t.mock.method(TeamStageDriver.prototype, 'execute', async function (args) {
      calls.drivers++
      await this.store.bindTeamStage(runId, {
        stageId: 'work',
        teamId: 'team-owned',
        leadSessionId: lead.id,
        taskSpecificationFingerprint: digest('task'),
        attemptId: args.attemptId
      })
      await this.store.bindTeamTask(runId, { taskId: task.id, taskRevision: 2 })
      await this.store.updateTeamStage(runId, { state: 'active', members: [member] })
      const claim = {
        runId,
        stageId: 'work',
        teamId: 'team-owned',
        actorSessionId: member.sessionId,
        memberId: member.memberId,
        taskId: task.id,
        effectId: 'known-native-claim',
        kind: 'task-update'
      }
      await recordTeamEffectIntent(this.store, claim)
      await recordTeamEffectResult(this.store, claim, { ok: true, taskId: task.id, taskRevision: 2, status: 'in_progress' })
      driverEntered.resolve({ attemptId: args.attemptId, signal: args.signal })
      const aborted = args.signal.aborted ? Promise.resolve() : new Promise(resolve => args.signal.addEventListener('abort', resolve, { once: true }))
      await Promise.all([aborted, drainEntered.promise])
      throw new TeamDriverError('teamstage-cancelled')
    })
    const driving = service.driveRun(handle, runId, graph)
    const { attemptId, signal } = await driverEntered.promise
    const before = await store.get(runId)
    assert.equal(before.state, 'running')
    assert.equal(before.teamStage.taskRevision, task.revision)
    assert.ok(before.teamStage.effects.every(effect => effect.state === 'succeeded'))
    const cancelling = service.cancelRun({ runId })
    await drainEntered.promise
    assert.equal(signal.aborted, true)
    const atDrain = await store.get(runId)
    assert.equal(atDrain.teamStage.cancel !== undefined, true)
    assert.ok(
      atDrain.teamStage.effects.some(effect => effect.kind === 'drain'),
      'actual coordinator reserved native drain'
    )
    // A fixed scheduler can return or join its current cancel tail. The old
    // scheduler signals after its erroneous recovery write has committed.
    const disposition = await Promise.race([schedulerDisposition.promise, driving.then(() => 'scheduler-returned')])
    releaseDrain.resolve()
    const [cancelResult] = await Promise.all([cancelling, driving])
    const final = await store.get(runId)
    const work = final.attempts.find(attempt => attempt.attemptId === attemptId)
    const cancellationEffects = final.teamStage.effects.filter(effect => ['drain', 'task-delete'].includes(effect.kind))
    t.diagnostic(
      JSON.stringify({
        backend,
        disposition,
        run_state: final.state,
        stage_state: final.teamStage.state,
        attempt_state: work.state,
        native_task: task,
        cancellation_effects: cancellationEffects,
        calls
      })
    )
    // These prerequisites must pass before the red assertion: a fixture or
    // native failure is not evidence of the scheduler settlement defect.
    assert.deepEqual(calls.interrupts, [member.name])
    assert.deepEqual(calls.drains, [[member.sessionId]])
    assert.deepEqual(calls.deletes, [{ taskId: task.id, expectedRevision: 2, action: 'delete' }])
    assert.deepEqual(task, { id: 'task-owned', revision: 3, status: 'deleted' })
    assert.equal(cancellationEffects.length, 2)
    assert.ok(cancellationEffects.every(effect => effect.state === 'succeeded' && effect.ok === true))
    assert.equal(cancellationEffects.find(effect => effect.kind === 'task-delete').resultTaskRevision, 3)
    assert.equal(final.teamStage.taskRevision, 2, 'canonical cancellation freezes the validated cutoff')
    assert.equal(final.teamStage.attemptId, attemptId)
    assert.equal(
      final.attempts.some(attempt => attempt.nodeId === 'sink'),
      false
    )
    assert.equal(final.teamStage.captures?.length ?? 0, 0)
    assert.equal(final.teamStage.outputAcceptance, undefined)
    assert.equal(cancelResult.state, 'cancelled', 'known drain/delete must win the scheduler abort catch')
    assert.equal(final.state, 'cancelled')
    assert.equal(final.teamStage.state, 'cancelled')
    assert.equal(work.state, 'cancelled')
    assert.equal(work.result.ok, false)
    assert.equal(work.result.outcome.kind, 'cancelled')
    assert.equal(work.result.seq, final.seq, 'original Attempt result belongs to the atomic terminal write')
    assert.equal(work.diagnostics.acceptance.code, 'cancelled')
    assert.equal(work.diagnostics.recovery, undefined)
    assert.equal(final.teamStage.recovery, undefined, 'caller cancellation is not an unknown native effect')
    assert.equal(
      final.log.some(event => event.kind === 'recovery'),
      false
    )
    const callsBeforeReplay = structuredClone(calls)
    assert.equal((await service.cancelRun({ runId })).state, 'cancelled')
    assert.deepEqual(calls, callsBeforeReplay)
    const beforeClose = await store.get(runId),
      oldContext = opened.ctx,
      oldDomain = opened.domain
    await opened.close()
    opened = await openBlueprintDomain({ backend, path })
    assert.notEqual(opened.ctx, oldContext)
    assert.notEqual(opened.domain, oldDomain)
    const restoredStore = new RunStore(opened.domain)
    assert.deepEqual(await restoredStore.get(runId), beforeClose, 'physical reopen preserves exact healthy cancellation and original result')
    assert.deepEqual((await reconcileOnStart(restoredStore)).untouched, [runId])
    assert.deepEqual(await restoredStore.get(runId), beforeClose)
    assert.deepEqual(calls, callsBeforeReplay, 'reopen/reconcile cannot redispatch any native cancellation effect')
  })

  test(`W2.7.3 healthy cancelled stage atomically settles the original graph Attempt ${backend}`, async t => {
    const root = await mkdtemp(join(tmpdir(), `blueprint-original-cancel-${backend}-`))
    await mkdir(join(root, 'store'))
    const path = backend === 'json' ? join(root, 'store') : join(root, 'store/runs.sqlite')
    let opened = await openBlueprintDomain({ backend, path })
    t.after(async () => {
      await opened.close()
      await rm(root, { recursive: true, force: true })
    })
    const store = new RunStore(opened.domain)
    const { runId } = await store.createRun(
      { scope: 'original-cancel', requestId: backend, payloadFingerprint: digest(root) },
      digest('definition'),
      '{}',
      '{}'
    )
    const attempt = await store.recordIntent(runId, {
      nodeId: 'work',
      kind: 'agentTask',
      diagnostics: {
        status: 'available',
        input: { type: 'object', bytes: 2, sha256: digest('{}') },
        resourceDigests: {},
        tools: { effectiveNames: [] },
        acceptance: { code: 'pending' }
      }
    })
    await store.bindTeamStage(runId, {
      stageId: 'work',
      teamId: 'team-owned',
      leadSessionId: 'lead-session',
      taskSpecificationFingerprint: digest('task'),
      attemptId: attempt.attemptId
    })
    await store.bindTeamTask(runId, { taskId: 'task-owned', taskRevision: 2 })
    await store.updateTeamStage(runId, { state: 'active' })
    await store.requestCancel(runId)
    for (const kind of ['drain', 'task-delete']) {
      const facts = {
        runId,
        stageId: 'work',
        teamId: 'team-owned',
        actorSessionId: 'lead-session',
        effectId: `known-${kind}`,
        kind,
        ...(kind === 'task-delete' ? { taskId: 'task-owned' } : {})
      }
      await recordTeamEffectIntent(store, facts)
      await recordTeamEffectResult(store, facts, {
        ok: true,
        status: kind === 'drain' ? 'drained' : 'deleted',
        ...(kind === 'task-delete' ? { taskId: 'task-owned', taskRevision: 3 } : {})
      })
    }
    await store.updateTeamStage(runId, { state: 'cancelled' })
    const before = await store.get(runId)
    assert.equal(before.state, 'cancelling')
    assert.equal(before.teamStage.state, 'cancelled')
    assert.equal(before.teamStage.recovery, undefined)
    assert.equal(before.attempts.find(item => item.attemptId === attempt.attemptId).state, 'cancelling')
    assert.ok(before.teamStage.effects.every(effect => effect.state === 'succeeded'))
    const settled = await store.settleTerminal(runId, 'cancelled', { reason: 'teamstage-cancelled' })
    assert.equal(settled.seq, before.seq + 1, 'Run and original Attempt settle in the same atomic write')
    assert.equal(settled.state, 'cancelled')
    assert.equal(settled.teamStage.state, 'cancelled')
    assert.equal(settled.attempts.length, 1, 'cancellation cannot manufacture a new Attempt')
    assert.equal(settled.teamStage.attemptId, attempt.attemptId)
    t.diagnostic(
      JSON.stringify({
        backend,
        run_state: settled.state,
        stage_state: settled.teamStage.state,
        original_attempt_state: settled.attempts[0].state,
        original_attempt_id: attempt.attemptId,
        effects: settled.teamStage.effects
      })
    )
    assert.equal(settled.attempts[0].state, 'cancelled', 'healthy graph-bound cancellation must settle the original Attempt')
    assert.equal(settled.attempts[0].result.ok, false)
    assert.equal(settled.attempts[0].result.outcome.kind, 'cancelled')
    assert.equal(settled.attempts[0].result.seq, settled.seq)
    assert.equal(settled.attempts[0].diagnostics.acceptance.code, 'cancelled')
    assert.equal(settled.attempts[0].diagnostics.recovery, undefined)
    assert.equal(settled.teamStage.recovery, undefined)
    assert.equal(settled.teamStage.outputAcceptance, undefined)
    assert.equal(
      settled.log.some(event => event.kind === 'recovery'),
      false
    )
    const oldContext = opened.ctx,
      oldDomain = opened.domain
    await opened.close()
    opened = await openBlueprintDomain({ backend, path })
    assert.notEqual(opened.ctx, oldContext)
    assert.notEqual(opened.domain, oldDomain)
    const restoredStore = new RunStore(opened.domain)
    assert.deepEqual(await restoredStore.get(runId), settled, 'physical reopen keeps original Attempt cancellation in the same durable record')
    assert.deepEqual((await reconcileOnStart(restoredStore)).untouched, [runId])
    assert.deepEqual(await restoredStore.get(runId), settled)
  })
}
