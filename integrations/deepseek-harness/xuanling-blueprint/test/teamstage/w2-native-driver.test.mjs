/** Public native Team boundary fixture: real Cordis/DSH Tools/SessionStore,
 * production admission, driver, snapshots and JSON store. Native roster and
 * model turns are deterministic scripts, not live provider evidence. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { RuntimeSnapshots } from '../../src/resources/runtime-snapshots.ts'
import { TeamOutputArtifacts } from '../../src/teamstage/output-artifact.ts'
import { TeamStageDriver } from '../../src/teamstage/driver.ts'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'
import { reconcileOnStart } from '../../src/orchestration/recovery.ts'
import { recordTeamEffectRecovery, TeamStageRunner } from '../../src/teamstage/runner.ts'
import { harness, definition, agentNode, agentResources, records, drain } from '../runtime-contracts/agent-fixtures.mjs'

export function teamDefinition(count = 1, extra = {}) {
  return definition(
    [
      agentNode({
        outputSchemaRef: 'answerSchema',
        outputs: { object: 'json', text: 'string' },
        teamStage: {
          task: { subject: 'Agree on answer', description: 'Produce the same structured answer together.' },
          members: Array.from({ length: count }, (_, i) => ({
            name: i === 0 ? 'producer' : `peer-${i}`,
            description: i === 0 ? 'Primary producer' : 'Required collaborator',
            agentRef: i === 0 ? 'primaryAgent' : 'peerAgent',
            context: i === 0 ? 'fresh' : 'fork'
          })),
          requiredChecks: ['schema']
        },
        ...extra
      }),
      { id: 'sink', kind: 'output', inputs: { object: 'json', text: 'string' }, outputs: { object: 'json', text: 'string' } }
    ],
    {
      ...agentResources,
      primaryAgent: { kind: 'agent', path: 'lib/agents/primary.md' },
      peerAgent: { kind: 'agent', path: 'lib/agents/peer.md' },
      answerSchema: { kind: 'schema', path: 'lib/schemas/answer.json' }
    },
    [
      { kind: 'data', from: 'work.object', to: 'sink.object' },
      { kind: 'data', from: 'work.text', to: 'sink.text' }
    ]
  )
}

// Service runtime uses JSON. Both backend restart controls below restore the
// exact production middleware snapshot into physical JSON/SQLite storage;
// they do not claim that the service selects a SQLite runtime backend.
for (const backend of ['json', 'sqlite'])
  for (const fault of ['cancel', 'pending-recovery', 'restart', 'result-write-failure']) {
    test(`native task observation/result window ${backend} ${fault} preserves unknown effect without redispatch`, async t => {
      const entered = Promise.withResolvers(),
        release = Promise.withResolvers(),
        spawned = Promise.withResolvers()
      t.after(() => release.resolve())
      let h,
        barrierCount = 0,
        writeFailures = 0,
        mutationResult,
        lateCaptureResult
      const nativeObserve = RunStore.prototype.observeTeamTaskRevision
      const nativeTransition = RunStore.prototype.transition
      t.mock.method(RunStore.prototype, 'transition', async function (runId, reducer) {
        const result = await nativeTransition.call(this, runId, reducer)
        if (result.teamStage?.effects?.some(effect => effect.kind === 'spawn' && effect.state === 'succeeded')) spawned.resolve()
        return result
      })
      t.mock.method(RunStore.prototype, 'observeTeamTaskRevision', async function (runId, task, previous) {
        const observed = await nativeObserve.call(this, runId, task, previous)
        if (task.taskRevision === 2 && barrierCount++ === 0) {
          entered.resolve({ store: this, record: observed })
          await release.promise
        }
        return observed
      })
      h = await teamHarness(t, {
        earlyReturn: true,
        beforeDrain: () => release.promise,
        onMember: async (call, team) => {
          mutationResult = await team.capture(call, { task_id: team.task.id, expected_revision: team.task.revision, action: 'claim' }, 'team_task_update')
          // A resumed native result must not allow output or another mutation.
          lateCaptureResult = await team.capture(call, { answer: 42 })
          call.finish({ kind: 'completed' }, '')
        }
      })
      const starting = h.start()
      const { store, record: observation } = await entered.promise
      await spawned.promise
      const pending = await store.get(observation.runId)
      const effect = pending.teamStage.effects.findLast(item => item.kind === 'task-update')
      const originalAttempt = pending.attempts.find(item => item.nodeId === 'work')
      assert.equal(pending.state, 'running')
      assert.equal(pending.teamStage.taskRevision, 2, 'actual observation committed before the exact barrier')
      assert.equal(h.team.task.revision, 2)
      assert.equal(effect.state, 'pending', 'native result has not yet been persisted')
      assert.equal(effect.resultTaskRevision, undefined)
      assert.equal(
        pending.teamStage.effects.some(item => item.kind === 'spawn' && item.state === 'pending'),
        false,
        'window oracle isolates the task result from native spawn uncertainty'
      )
      assert.equal(h.team.calls.filter(action => action === 'claim').length, 1)

      // Preserve this exact in-flight record in a real backend, close its actual
      // domain, and reopen with a fresh context/store before reconciliation.
      const snapshotRoot = join(h.root, `task-result-window-${backend}-${fault}`)
      mkdirSync(snapshotRoot, { recursive: true })
      const snapshotPath = backend === 'json' ? snapshotRoot : join(snapshotRoot, 'runs.sqlite')
      let opened = await openBlueprintDomain({ backend, path: snapshotPath })
      await opened.domain.table('runs').put(pending.runId, pending)
      const previousContext = opened.ctx,
        previousDomain = opened.domain
      await opened.close()
      opened = await openBlueprintDomain({ backend, path: snapshotPath })
      t.after(() => opened.close())
      assert.notEqual(opened.ctx, previousContext)
      assert.notEqual(opened.domain, previousDomain)
      const restoredStore = new RunStore(opened.domain)
      assert.deepEqual(await restoredStore.get(pending.runId), pending, 'reopen retains the exact production pending snapshot')
      const restartReport = await reconcileOnStart(restoredStore)
      const restored = await restoredStore.get(pending.runId)
      assert.equal(restartReport.recoveryRequired.length, 1)
      assert.equal(restartReport.recoveryRequired[0].attemptId, originalAttempt.attemptId)
      assert.equal(restartReport.recoveryRequired[0].intentKind, 'task-update')
      assert.equal(restored.teamStage.taskRevision, 2)
      assert.equal(restored.state, 'recovery_required')
      assert.equal(restored.attempts.find(item => item.attemptId === originalAttempt.attemptId).state, 'recovery_required')
      assert.equal(restored.teamStage.effects.find(item => item.effectId === effect.effectId).state, 'pending')
      noGraphSuccess(restored)
      let replayDispatches = 0
      await assert.rejects(
        new TeamStageRunner(restoredStore).dispatch({
          ...effect,
          runId: pending.runId,
          store: restoredStore,
          effect: () => {
            replayDispatches++
            return {}
          }
        }),
        error => error.code === 'TEAM_EFFECT_UNKNOWN'
      )
      assert.equal(replayDispatches, 0, 'restored pending native claim is never dispatched again')
      assert.deepEqual(await restoredStore.get(pending.runId), restored)
      assert.deepEqual((await reconcileOnStart(restoredStore)).untouched, [pending.runId])
      assert.deepEqual(await restoredStore.get(pending.runId), restored, 'second reconciliation cannot invent late success')

      if (fault === 'cancel') {
        const result = await h.service.cancelRun({ runId: pending.runId })
        assert.equal(result.state, 'recovery_required')
        assert.equal((await store.get(pending.runId)).teamStage.effects.find(item => item.effectId === effect.effectId).state, 'recovery_required')
      } else if (fault === 'pending-recovery') {
        await recordTeamEffectRecovery(store, { ...effect, runId: pending.runId })
        await reconcileOnStart(store)
      } else if (fault === 'restart') {
        // The restart oracle is the independently reopened physical snapshot
        // above: a crashed process has no surviving continuation. Settle this
        // still-live fixture separately with explicit effect recovery solely
        // for teardown; do not call a live startup reconciliation a crash.
        await recordTeamEffectRecovery(store, { ...effect, runId: pending.runId })
        await reconcileOnStart(store)
      } else {
        t.mock.method(store, 'transition', async (runId, reducer) =>
          nativeTransition.call(store, runId, draft => {
            reducer(draft)
            const changed = draft.teamStage?.effects?.find(item => item.effectId === effect.effectId)
            if (writeFailures === 0 && changed?.state === 'succeeded') {
              writeFailures++
              throw new Error('INJECTED_TASK_RESULT_WRITE_FAILURE')
            }
          })
        )
      }
      release.resolve()
      const { record, startArgs } = await starting
      assert.equal(barrierCount, 1)
      assert.equal(
        mutationResult.isError,
        true,
        fault === 'restart'
          ? 'explicit fixture teardown recovery rejects its surviving continuation'
          : 'late/failed effect result cannot return success to the model'
      )
      assert.equal(lateCaptureResult.isError, true, 'unknown result stops same-turn output')
      assert.equal(writeFailures, fault === 'result-write-failure' ? 1 : 0, 'exactly the intended result write fails once')
      assert.equal(h.team.calls.filter(action => action === 'claim').length, 1)
      assert.equal(h.team.calls.includes('complete'), false)
      assert.equal(record.state, 'recovery_required')
      assert.equal(record.teamStage.taskRevision, 2)
      assert.equal(record.teamStage.attemptId, originalAttempt.attemptId)
      assert.equal(record.attempts.find(item => item.attemptId === originalAttempt.attemptId).state, 'recovery_required')
      assert.notEqual(record.teamStage.effects.find(item => item.effectId === effect.effectId).state, 'succeeded')
      assert.equal(record.teamStage.captures?.length ?? 0, 0)
      const artifactPath = join(h.runtimeRoot, 'store/team-output-artifacts')
      assert.deepEqual(existsSync(artifactPath) ? readdirSync(artifactPath) : [], [])
      noGraphSuccess(record)
      const callsBeforeReplay = [...h.team.calls],
        memberCount = h.host.calls.length
      await h.service.startSessionRun(startArgs)
      await drain(h)
      assert.deepEqual(h.team.calls, callsBeforeReplay)
      assert.equal(h.host.calls.length, memberCount, 'public original-command replay starts no member/model turn')
      assert.deepEqual(
        (await records(h)).find(item => item.runId === record.runId),
        record
      )
      t.diagnostic(
        JSON.stringify({
          backend,
          fault,
          actual_scope_backend: 'json',
          native_claims: 1,
          original_attempt: originalAttempt.attemptId,
          task_revision: 2,
          effect_state: record.teamStage.effects.find(item => item.effectId === effect.effectId).state,
          restart_pending_snapshot: true,
          result_write_failures: writeFailures,
          ...(fault === 'restart' ? { original_continuation_teardown: 'explicit-effect-recovery-independent-of-restart-oracle' } : {})
        })
      )
    })
  }

export async function teamHarness(
  t,
  { count = 1, onMember, providers = true, nativeFault, earlyReturn = false, childTools = true, scopedSessions = false, beforeDrain, ...options } = {}
) {
  let team
  const h = await harness(t, {
    ...options,
    onTurn: async call => {
      assert.ok(team, 'fixture native Team service installed before model turn')
      if (onMember) return onMember(call, team)
      const row = team.roster.find(row => row.id === call.agent.id)
      if (row.logical === 'producer') {
        await team.capture(call, { task_id: team.task.id, expected_revision: team.task.revision, action: 'claim' }, 'team_task_update')
        await team.capture(call, { task_id: team.task.id, expected_revision: team.task.revision, action: 'complete' }, 'team_task_update')
      }
      await team.capture(call, { answer: 42 })
      call.finish({ kind: 'completed' }, '')
    }
  })
  mkdirSync(join(h.rootDir, 'lib/agents'), { recursive: true })
  writeFileSync(join(h.rootDir, 'lib/agents/primary.md'), 'PRIMARY_AGENT_FROZEN')
  writeFileSync(join(h.rootDir, 'lib/agents/peer.md'), 'PEER_AGENT_FROZEN')
  // Installed DSH services are sibling plugins, not root-owned fixture grants.
  if (scopedSessions) await h.ctx.plugin(SessionStore)
  else new SessionStore(h.ctx)
  h.ctx.on('session/flush', () => {})
  const live = new Map()
  const handles = new Map()
  h.host.registry.get = id => live.get(id)
  const originalCreate = h.host.registry.create.bind(h.host.registry)
  h.host.registry.create = async options => {
    const handle = await originalCreate(options)
    if (scopedSessions)
      await handle.agent.ctx.inject(['sessions'], ctx => {
        handle.agent.ctx = ctx
      })
    live.set(handle.agent.id, handle.agent)
    const detach = handle.agent.ctx.sessions.enter(handle.agent.session)
    handle.agent.ctx.sessions.announce(handle.agent.session)
    try {
      await h.ctx.serial('agent/created', { agent: handle.agent, source: 'fresh', signal: options.signal })
    } catch (error) {
      t.diagnostic(JSON.stringify({ creationFailure: error.code, issueCode: error.issueCode }))
      throw error
    }
    t.after(() => detach())
    const owned = {
      ...handle,
      async dispose() {
        await handle.dispose()
        assert.equal(live.get(handle.agent.id), handle.agent, 'release owns the exact registered Agent')
        live.delete(handle.agent.id)
        h.ctx.emit('agent/disposed', { agent: handle.agent })
        detach()
      }
    }
    handles.set(handle.agent.id, owned)
    return owned
  }
  const root = (await h.host.registry.create({ sessionId: SessionId(`root-${randomUUID()}`) })).agent
  const calls = []
  const roster = []
  const pendingPrompts = []
  team = {
    root,
    calls,
    roster,
    pendingPrompts,
    async release(agent) {
      await agent.whenIdle()
      assert.equal(agent.status, 'idle')
      assert.equal(await agent.ctx.sessions.flush(agent.session), true)
      await handles.get(agent.id).dispose()
    },
    task: undefined,
    membership(agent) {
      assert.equal(live.get(agent.id), agent, 'native membership exact registry')
      if (agent === root) return { root, id: root.id, role: 'lead', name: 'lead' }
      const row = roster.find(row => row.id === agent.id)
      assert.ok(row, 'native child must have provisional roster row')
      return { root, id: root.id, role: 'teammate', name: row.name }
    },
    listMembers() {
      return roster.map(({ logical: _logical, ...row }) => ({ ...row, status: live.get(row.id)?.status === 'running' ? 'running' : row.status }))
    },
    async createTask(caller, request) {
      assert.equal(caller, root)
      calls.push('create')
      if (nativeFault === 'create') throw new Error('native append/flush outcome unknown')
      team.task = { id: `task-${randomUUID()}`, revision: 1, status: 'pending', ...request }
      return structuredClone(team.task)
    },
    getTask(caller, id) {
      assert.equal(id, team.task.id)
      return structuredClone(team.task)
    },
    listTasks() {
      return team.task ? [structuredClone(team.task)] : []
    },
    async updateTask(caller, request) {
      assert.equal(request.taskId, team.task.id)
      assert.equal(request.expectedRevision, team.task.revision)
      team.task = { ...team.task, revision: team.task.revision + 1, status: request.action === 'claim' ? 'in_progress' : 'completed' }
      calls.push(request.action)
      return structuredClone(team.task)
    },
    async spawnTeammate(caller, request) {
      assert.equal(caller, root)
      calls.push('spawn')
      const id = SessionId(randomUUID())
      const logical = roster.length === count - 1 ? 'producer' : `peer-${roster.length + 1}`
      const row = { id, name: request.name, logical, provider: request.provider, context: request.context, status: 'provisioning' }
      roster.push(row) // Must precede agent/created, just like native appendAndFlush.
      if (nativeFault === 'spawn') throw new Error('native provisional append outcome unknown')
      const handle = await h.host.registry.create({ sessionId: id, meta: { origin: 'subagent', parentSession: root.id } })
      pendingPrompts.push({ request, agent: handle.agent })
      handle.agent.followup(createUserMessage({ content: request.prompt, source: { kind: 'user' } }))
      row.status = 'inactive'
      // Creation/capture must work even if first prompt finishes before return.
      if (!earlyReturn) await handle.agent.whenIdle()
      return { member: { ...row, status: handle.agent.status === 'running' ? 'running' : 'inactive' } }
    },
    async sendMessage(caller, request) {
      assert.notEqual(request.target, 'lead', 'driver must not send Lead self-message')
      const row = roster.find(row => row.name === request.target)
      assert.ok(row, 'fixture: target must already be reserved in native roster')
      calls.push('message')
      return { messageId: randomUUID() }
    },
    async waitForChange() {},
    interrupt() {
      calls.push('interrupt')
      return { previousStatus: 'inactive' }
    },
    async capture(call, value, name = 'structured_output', extra = {}) {
      const callId = ToolCallId(randomUUID())
      call.session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(value) })
      const result = await call.agent.ctx.tools.execute({ callId, name, arguments: value, agent: call.agent, signal: new AbortController().signal, ...extra })
      call.session.append(
        'tool/result',
        { turn: 1, step: 1, message: createToolResultMessage({ callId, content: result.content, isError: result.isError }) },
        { surfaceOp: 'append' }
      )
      call.toolResults.push(result)
      return result
    }
  }
  h.ctx.provide('agentTeams', team)
  const installNativeTools = agent => {
    for (const name of ['send_message', 'list_agents', 'wait_agent', 'team_task_list', 'team_task_get', 'team_task_update']) {
      agent.ctx.tools.register({
        name,
        description: 'Native Team boundary fixture',
        parameters: { type: 'object', additionalProperties: true },
        output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'native Team result' }] },
        async execute(args, exec) {
          if (name === 'team_task_update')
            return team.updateTask(exec.agent, { taskId: args.task_id, expectedRevision: args.expected_revision, action: args.action })
          if (name === 'team_task_get') return team.getTask(exec.agent, args.task_id)
          if (name === 'send_message') return team.sendMessage(exec.agent, { target: args.target })
          return { ok: true }
        }
      })
    }
  }
  installNativeTools(root)
  h.ctx.on('agent/created', ({ agent }) => {
    if (childTools) installNativeTools(agent)
  })
  const providerMap = new Map(
    providers
      ? [
          ['spawn', { name: 'spawn', inheritsParentContext: false, prepareContinuable() {} }],
          ['fork', { name: 'fork', inheritsParentContext: true, prepareContinuable() {} }]
        ]
      : []
  )
  h.ctx.provide('subagents', { getProvider: name => providerMap.get(name) })
  return {
    ...h,
    team,
    rootAgent: root,
    providerMap,
    live,
    async start(value = teamDefinition(count), requestId = randomUUID()) {
      const doc = await h.save(value)
      let admitted, refusal
      const startArgs = {
        sessionId: root.id,
        blueprintId: doc.blueprintId,
        expectedRevision: doc.documentRevision,
        inputJson: JSON.stringify({ task: 'answer' }),
        requestId
      }
      try {
        admitted = await h.service.startSessionRun(startArgs)
      } catch (error) {
        refusal = error
      }
      // The observation-window tests intentionally pause a production job.
      // Start the unchanged settlement budget only after their explicit release.
      if (beforeDrain) await beforeDrain()
      await drain(h)
      return { admitted, refusal, doc, startArgs, record: admitted ? (await records(h)).find(r => r.runId === admitted.runId) : undefined }
    }
  }
}

test('test-owned barrier gates settlement observation without delaying production work', async t => {
  const reached = Promise.withResolvers(),
    release = Promise.withResolvers()
  t.after(() => release.resolve())
  const h = await teamHarness(t, {
    beforeDrain: () => {
      reached.resolve('barrier')
      return release.promise
    }
  })
  let settled = false
  const starting = h.start().then(result => {
    settled = true
    return result
  })
  assert.equal(await Promise.race([reached.promise, starting.then(() => 'settled')]), 'barrier')
  // Production finishes while start's observation remains paused by the test.
  await drain(h)
  assert.equal(h.host.calls.length > 0, true, 'production work starts before barrier release')
  assert.equal(settled, false, 'start must not finish its gated settlement phase')
  release.resolve()
  const { record, refusal } = await starting
  assert.equal(refusal, undefined)
  assert.equal(record.state, 'succeeded')
  assert.equal(h.drivers.size, 0)
  assert.equal(h.host.pending.size, 0)
})

test('TeamStage does not create a private total deadline; DSH owns provider and disposal timing', async t => {
  t.mock.method(AbortSignal, 'timeout', () => {
    throw new Error('BLUEPRINT_PRIVATE_DEADLINE')
  })
  const h = await teamHarness(t)
  const { refusal, record } = await h.start()
  assert.equal(refusal, undefined)
  assert.equal(record.state, 'succeeded')
  assert.deepEqual(record.teamStage.execution, { startedAt: record.teamStage.execution.startedAt })
  assert.equal(Object.hasOwn(record.teamStage.execution, 'timeoutMs'), false)
  assert.equal(Object.hasOwn(record.teamStage.execution, 'deadlineAt'), false)
})

test('native member parallel tools remain executing until the last owned tool completes', async t => {
  let h
  h = await teamHarness(t, {
    earlyReturn: true,
    onMember: async (call, team) => {
      const first = Promise.withResolvers(),
        second = Promise.withResolvers()
      const entered = [Promise.withResolvers(), Promise.withResolvers()]
      let ordinal = 0
      const original = team.getTask.bind(team)
      t.mock.method(team, 'getTask', (caller, id) => {
        if (caller === team.root) return original(caller, id)
        const index = ordinal++
        entered[index].resolve()
        return [first, second][index].promise.then(() => original(caller, id))
      })
      const inspect = async () => (await h.service.inspectSession({ sessionId: team.root.id })).selected.run
      for (let i = 0; i < 100; i++) {
        const run = await inspect()
        if (run.team?.members[0]?.phase === 'active') break
        await new Promise(resolve => setImmediate(resolve))
      }
      const one = team.capture(call, { task_id: team.task.id }, 'team_task_get')
      const two = team.capture(call, { task_id: team.task.id }, 'team_task_get')
      await Promise.all(entered.map(value => value.promise))
      let current
      for (let i = 0; i < 100; i++) {
        current = await inspect()
        if (current.team?.runtime?.members?.length) break
        await new Promise(resolve => setImmediate(resolve))
      }
      assert.equal(current?.team?.runtime?.members[0]?.activity, 'executing_tool', JSON.stringify({ state: current?.state, team: current?.team }))
      first.resolve()
      await one
      assert.equal((await inspect()).team.runtime.members[0].activity, 'executing_tool', 'a finished tool cannot hide another active tool')
      second.resolve()
      await two
      assert.equal((await inspect()).team.runtime.members[0].activity, 'idle')
      await team.capture(call, { task_id: team.task.id, expected_revision: team.task.revision, action: 'claim' }, 'team_task_update')
      await team.capture(call, { task_id: team.task.id, expected_revision: team.task.revision, action: 'complete' }, 'team_task_update')
      await team.capture(call, { answer: 42 })
      call.finish({ kind: 'completed' }, '')
    }
  })
  const { record } = await h.start()
  assert.equal(record.state, 'succeeded')
})

test('native stream events project waiting, reasoning, response and tool preparation only to the bound member', async t => {
  let h
  h = await teamHarness(t, {
    earlyReturn: true,
    onMember: async (call, team) => {
      const inspect = async () => (await h.service.inspectSession({ sessionId: team.root.id })).selected.run
      for (let i = 0; i < 100; i++) {
        const run = await inspect()
        if (run.team?.members[0]?.phase === 'active') break
        await new Promise(resolve => setImmediate(resolve))
      }
      const entered = Promise.withResolvers(),
        progress = Promise.withResolvers()
      const stream = h.ctx
        .waterfall(null, 'llm/stream', { sessionId: call.agent.id }, async function* () {
          entered.resolve()
          await progress.promise
          yield { type: 'reasoning-delta', index: 0, text: 'RAW_REASONING_SENTINEL' }
          yield { type: 'text-delta', index: 1, text: 'RAW_RESPONSE_SENTINEL' }
          yield { type: 'tool-call-delta', index: 2, id: ToolCallId('stream-tool'), name: 'team_task_get', argumentsDelta: '{}' }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        })
        [Symbol.asyncIterator]()
      const initial = stream.next()
      await entered.promise
      let before = await inspect()
      let ready = before
      for (let i = 0; i < 100 && !ready.team?.runtime?.members?.length; i++) {
        await new Promise(resolve => setImmediate(resolve))
        ready = await inspect()
      }
      assert.equal(ready.team?.runtime?.members[0]?.activity, 'waiting_model', JSON.stringify({ state: ready.state, team: ready.team }))
      before = ready
      progress.resolve()
      await initial
      const thinking = await inspect()
      assert.equal(thinking.team.runtime.members[0].activity, 'thinking')
      assert.equal(thinking.team.runtime.members[0].reasoningDeltas, 1)
      assert.equal(thinking.seq, before.seq)
      for await (const _ of h.ctx.waterfall(null, 'llm/stream', { sessionId: 'foreign-session' }, async function* () {
        yield { type: 'text-delta', index: 0, text: 'FOREIGN_RESPONSE' }
      })) {
      }
      assert.equal((await inspect()).team.runtime.members[0].activity, 'thinking')
      await stream.next()
      assert.equal((await inspect()).team.runtime.members[0].activity, 'responding')
      await stream.next()
      assert.equal((await inspect()).team.runtime.members[0].activity, 'tool_call')
      await stream.next()
      await stream.next()
      const closed = await inspect()
      assert.equal(closed.team.runtime.members[0].activity, 'idle')
      assert.equal(closed.seq, before.seq, 'all stream activity remains transient')
      assert.equal(JSON.stringify(closed).includes('SENTINEL'), false)
      await team.capture(call, { task_id: team.task.id, expected_revision: team.task.revision, action: 'claim' }, 'team_task_update')
      await team.capture(call, { task_id: team.task.id, expected_revision: team.task.revision, action: 'complete' }, 'team_task_update')
      await team.capture(call, { answer: 42 })
      call.finish({ kind: 'completed' }, '')
    }
  })
  const { record } = await h.start()
  assert.equal(record.state, 'succeeded')
  const terminal = await h.service.inspectRun({ runId: record.runId })
  assert.equal(terminal.team.runtime, undefined)
  assert.equal(JSON.stringify(record).includes('SENTINEL'), false)
})

test('F8 public Team preflight reports ready only while native capability is available', async t => {
  const h = await teamHarness(t)
  const doc = await h.save(teamDefinition())
  const args = { blueprintId: doc.blueprintId, expectedRevision: doc.documentRevision, inputJson: '{}' }
  const ready = await h.service.preflightRun(args)
  assert.equal(ready.canStart, true)
  assert.ok(ready.checks.some(check => check.nodeId === 'work' && check.code === 'teamstage-executor-ready' && check.status === 'pass'))
  assert.ok(ready.checks.some(check => check.nodeId === 'work' && check.code === 'node-executor-ready' && check.status === 'pass'))
  const provider = h.providerMap.get('spawn')
  h.providerMap.delete('spawn')
  const blocked = await h.service.preflightRun(args)
  assert.equal(blocked.canStart, false)
  assert.ok(blocked.checks.some(check => check.nodeId === 'work' && check.code === 'teamstage-provider-unavailable' && check.status === 'block'))
  assert.equal(
    blocked.checks.some(check => check.nodeId === 'work' && check.code === 'node-executor-ready'),
    false
  )
  assert.equal(
    blocked.checks.some(check => check.code === 'teamstage-executor-ready'),
    false
  )
  const otherChecks = report =>
    report.checks.filter(check => !(check.nodeId === 'work' && (check.code === 'node-executor-ready' || check.code.startsWith('teamstage-'))))
  assert.deepEqual(otherChecks(blocked), otherChecks(ready), 'blocked Team capability preserves all other preflight diagnostics')
  h.providerMap.set('spawn', provider)
  assert.deepEqual(await h.service.preflightRun(args), ready, 'public preflight reevaluates dynamic capability')
  assert.deepEqual(h.team.calls, [])
  assert.equal(h.host.calls.length, 1, 'preflight creates no Agent beyond the fixture existing root')
  assert.deepEqual(h.effects, [])
  assert.deepEqual(await records(h), [])
})

test('F8 ordinary agent preflight preserves executor-ready without Team diagnostics or effects', async t => {
  const h = await harness(t)
  const doc = await h.save(definition())
  const report = await h.service.preflightRun({ blueprintId: doc.blueprintId, expectedRevision: doc.documentRevision, inputJson: '{}' })
  assert.equal(report.canStart, true)
  assert.ok(report.checks.some(check => check.nodeId === 'work' && check.code === 'node-executor-ready' && check.status === 'pass'))
  assert.equal(
    report.checks.some(check => check.code.startsWith('teamstage-')),
    false
  )
  assert.deepEqual(h.host.calls, [])
  assert.deepEqual(h.effects, [])
  assert.deepEqual(await records(h), [])
})

test('C-01 ordinary Agents and native TeamStage hold exclusive Run ownership in both directions', async t => {
  const gates = new Map(['a', 'work', 'b'].map(id => [id, Promise.withResolvers()]))
  const started = new Set()
  const observe = async predicate => {
    for (let turn = 0; turn < 20_000; turn++) {
      if (await predicate()) return true
      await new Promise(resolve => setImmediate(resolve))
    }
    return false
  }
  let h, handle
  h = await teamHarness(t, {
    earlyReturn: true,
    onMember: async (call, team) => {
      const row = team.roster.find(row => row.id === call.agent.id)
      const nodeId = row ? 'work' : (await records(h)).flatMap(run => run.attempts).find(attempt => attempt.sessionId === call.session.id)?.nodeId
      assert.ok(gates.has(nodeId), 'only declared ordinary nodes and native Team members reach the model')
      started.add(nodeId)
      await gates.get(nodeId).promise
      if (row) {
        await completeTask(call, team)
        await team.capture(call, { answer: 42 })
        call.finish({ kind: 'completed' }, '')
      } else call.finish({ kind: 'completed' }, nodeId.toUpperCase())
    }
  })
  handle = await h.service.runtimeFor(h.runtimeRoot)
  const value = teamDefinition()
  const ordinary = id => ({ id, kind: 'agentTask', agentRef: 'worker' })
  value.graph.nodes = [ordinary('a'), value.graph.nodes[0], ordinary('b'), value.graph.nodes[1]]
  const doc = await h.save(value)
  const admitted = await h.service.startSessionRun({
    sessionId: h.rootAgent.id,
    blueprintId: doc.blueprintId,
    expectedRevision: doc.documentRevision,
    inputJson: '{}',
    requestId: randomUUID()
  })
  try {
    assert.equal(await observe(() => started.has('a')), true)
    assert.equal(await observe(() => h.team.calls.includes('create')), false, 'TEAM_STARTED_WITH_LIVE_AGENT: native stage waits until ordinary work drains')
    assert.equal(started.has('b'), false)
    gates.get('a').resolve()
    assert.equal(await observe(() => started.has('work')), true)
    assert.equal(await observe(() => started.has('b')), false, 'AGENT_STARTED_WITH_LIVE_TEAM: ordinary work waits until native stage settles')
    gates.get('work').resolve()
    assert.equal(await observe(() => started.has('b')), true)
    gates.get('b').resolve()
    await handle.driverTail
    const record = await handle.store.get(admitted.runId)
    assert.equal(record.state, 'succeeded')
    assert.equal(record.teamStage.state, 'succeeded')
    assert.ok(['a', 'work', 'b', 'sink'].every(id => record.attempts.find(attempt => attempt.nodeId === id)?.state === 'succeeded'))
  } finally {
    for (const gate of gates.values()) gate.resolve()
    await handle.driverTail
    await h.close()
    assert.deepEqual(h.host.errors, [])
  }
})

async function pluginDriverContext(t, h, selectSessions) {
  let observer
  const fiber = await h.ctx.plugin({
    name: 'teamstage-optional-observer-fixture',
    inject: [],
    apply(ctx) {
      observer = ctx
    }
  })
  t.after(() => fiber.dispose())
  assert.ok(observer.fiber.runtime, 'oracle uses an actual Cordis plugin runtime')
  assert.throws(() => observer.sessions, /cannot get property "sessions" without inject/)
  assert.equal(typeof observer.get('sessions').flush, 'function', 'optional service exists through public get')
  if (selectSessions) {
    const get = observer.get.bind(observer)
    observer = observer.extend({
      get(name) {
        const value = get(name)
        return name === 'sessions' ? selectSessions(value) : value
      }
    })
  }
  const execute = TeamStageDriver.prototype.execute
  t.mock.method(TeamStageDriver.prototype, 'execute', function (args) {
    // Keep the real driver/store/resources and replace only its context with
    // the actual inject=[] plugin context used at the installed boundary.
    return execute.call(new TeamStageDriver(observer, this.store, this.runtimeRoot, this.providers), args)
  })
  return observer
}

test('F7 real inject-empty Cordis plugin context completes native capture through optional SessionStore', async t => {
  const h = await teamHarness(t, { scopedSessions: true })
  await pluginDriverContext(t, h)
  const { refusal, record } = await h.start()
  assert.equal(refusal, undefined, 'real plugin context reaches native driver and first prompt')
  const member = h.host.calls[1]
  assert.equal(member.agent.status, 'idle')
  assert.equal(member.toolResults.at(-1).isError, false, 'authoritative Tools capture succeeded')
  const work = record.attempts.find(a => a.nodeId === 'work')
  t.diagnostic(JSON.stringify({ state: record.state, recovery: record.teamStage.recovery?.code, captures: record.teamStage.captures?.length }))
  assert.equal(record.state, 'succeeded', 'available optional SessionStore must flush without declaring inject')
  assert.equal(record.teamStage.captures.length, 1)
  assert.equal(record.teamStage.attemptId, work.attemptId)
  assert.deepEqual(record.attempts.find(a => a.nodeId === 'sink').result.outcome.outputs, work.result.outcome.outputs)
})

test('F7 real Cordis plugin observer retains F6 proof after peer release before primary completion', async t => {
  const released = Promise.withResolvers()
  let peerId
  const h = await teamHarness(t, {
    scopedSessions: true,
    count: 2,
    earlyReturn: true,
    onMember: async (call, team) => {
      if (team.roster.find(row => row.id === call.agent.id).logical === 'producer') {
        await released.promise
        assert.equal(h.live.has(peerId), false)
        await completeTask(call, team)
        await team.capture(call, { answer: 42 })
        call.finish({ kind: 'completed' }, '')
      } else {
        peerId = call.agent.id
        await team.capture(call, { answer: 42 })
        call.finish({ kind: 'completed' }, '')
        await team.release(call.agent)
        released.resolve()
      }
    }
  })
  await pluginDriverContext(t, h)
  const { refusal, record } = await h.start()
  assert.equal(refusal, undefined)
  assert.equal(record.state, 'succeeded')
  assert.equal(record.teamStage.captures.length, 2)
  assert.ok(record.teamStage.captures.find(ref => ref.evidence.producerSessionId === peerId))
})

for (const fault of ['unavailable', 'missing-flush', 'rejected-flush', 'nonparticipating-flush']) {
  test(`F7 real Cordis plugin optional SessionStore ${fault} has typed refusal`, async t => {
    let captureStarted = false
    const h = await teamHarness(t, {
      scopedSessions: true,
      onMember: async (call, team) => {
        await completeTask(call, team)
        await team.capture(call, { answer: 42 })
        captureStarted = true // Dynamic disappearance/failure after admission and creation.
        call.finish({ kind: 'completed' }, '')
      }
    })
    await pluginDriverContext(t, h, sessions => {
      if (!captureStarted) return sessions
      if (fault === 'unavailable') return undefined
      if (fault === 'missing-flush') return {}
      return {
        async flush() {
          if (fault === 'rejected-flush') throw new Error('RAW_FLUSH_FAILURE_SENTINEL')
          return false
        }
      }
    })
    const { refusal, record } = await h.start()
    assert.equal(refusal, undefined)
    assert.equal(captureStarted, true)
    noGraphSuccess(record)
    assert.equal(record.teamStage.captures, undefined)
    assert.equal(
      record.teamStage.recovery.code,
      ['unavailable', 'missing-flush'].includes(fault) ? 'teamstage-executor-unavailable' : 'teamstage-flush-unverified'
    )
    assert.equal(JSON.stringify(record).includes('RAW_FLUSH_FAILURE_SENTINEL'), false)
  })
}

test('native automatic Team production admission dispatches on the exact existing root Lead', async t => {
  const h = await teamHarness(t)
  const { refusal, record } = await h.start()
  t.diagnostic(JSON.stringify({ refusal: refusal?.code, checks: refusal?.details?.checks, nativeCalls: h.team.calls }))
  assert.equal(refusal, undefined, 'valid sourced Team must pass production admission')
  assert.equal(h.team.calls.filter(c => c === 'create').length, 1)
  assert.equal(h.team.roster.length, 1)
  assert.equal(record.teamStage.leadSessionId, h.rootAgent.id)
  assert.equal(record.state, 'succeeded')
})

test('native first prompt already completed before spawn returns still captures and settles the same graph Attempt', async t => {
  const h = await teamHarness(t)
  const { refusal, record } = await h.start()
  assert.equal(refusal, undefined, 'production Team capture must be reachable')
  assert.equal(h.host.calls.length, 2, 'one existing root plus one native child, no ordinary executor')
  assert.equal(h.host.calls[1].toolResults[0].isError, false, 'scope was installed before first prompt')
  const stage = record.teamStage
  const original = record.attempts.find(a => a.nodeId === 'work')
  assert.equal(stage.attemptId, original.attemptId)
  assert.equal(original.state, 'succeeded')
  assert.deepEqual(original.result.outcome.outputs, { object: { answer: 42 }, text: '{"answer":42}' })
  assert.deepEqual(record.attempts.find(a => a.nodeId === 'sink').result.outcome.outputs, original.result.outcome.outputs)
  assert.equal(stage.members[0].phase, 'active')
  assert.ok(stage.members[0].evidence.completedTurnId)
})

test('collaborators launch before primary with unique saved native names; policy stays declaration-first', async t => {
  const h = await teamHarness(t, { count: 2 })
  const { refusal, record } = await h.start()
  assert.equal(refusal, undefined, 'production multi-member Team dispatch must be reachable')
  assert.equal(record.state, 'succeeded')
  const prompts = h.team.pendingPrompts
  assert.equal(prompts[0].request.context, 'fork')
  assert.equal(prompts[1].request.context, 'fresh')
  assert.match(prompts[0].request.name, /^bp-[0-9a-f-]{36}$/)
  assert.notEqual(prompts[0].request.name, prompts[1].request.name)
  assert.ok(JSON.stringify(prompts[0].request.prompt).includes('PEER_AGENT_FROZEN'))
  assert.ok(JSON.stringify(prompts[1].request.prompt).includes('PRIMARY_AGENT_FROZEN'))
  const primary = record.teamStage.members.find(m => m.memberId === record.teamStage.primaryMemberId)
  assert.equal(primary.sessionId, prompts[1].agent.id)
  assert.deepEqual(record.teamStage.requiredMemberIds.length, 2)
})

test('F6 completed collaborator native release after finish preserves authoritative capture at final driver check', async t => {
  const h = await teamHarness(t, { count: 2 })
  const nativeSpawn = h.team.spawnTeammate
  let released
  let didRelease = false
  h.team.spawnTeammate = async (...args) => {
    const result = await nativeSpawn(...args)
    const row = h.team.roster.find(row => row.id === result.member.id)
    if (row.logical !== 'producer') {
      released = h.live.get(row.id)
      assert.equal(released.status, 'idle')
      assert.equal(h.host.calls.find(call => call.agent === released).toolResults.at(-1).isError, false)
    }
    return result
  }
  const commitCapture = TeamOutputArtifacts.prototype.commitCapture
  t.mock.method(TeamOutputArtifacts.prototype, 'commitCapture', async function (args) {
    const result = await commitCapture.call(this, args)
    // Driver reaches this only after every scope.finish succeeded. Release the
    // peer while the primary artifact commits, before the peer's final check.
    if (!didRelease) {
      await h.team.release(released)
      didRelease = true
    }
    assert.equal(h.live.get(released.id), undefined, 'native cold release removes exact Agent')
    assert.equal(released.ctx.sessions.get(released.id), undefined, 'release also detaches Session')
    return result
  })
  const { refusal, record } = await h.start()
  assert.equal(refusal, undefined, 'production admission and creation are reachable')
  const work = record.attempts.find(a => a.nodeId === 'work')
  t.diagnostic(JSON.stringify({ state: record.state, recovery: record.teamStage.recovery?.code, captures: record.teamStage.captures?.length }))
  assert.equal(record.state, 'succeeded', 'legitimate completed native release must satisfy final quiescence')
  assert.equal(work.state, 'succeeded')
  assert.equal(record.teamStage.captures.length, 2)
  const peer = record.teamStage.captures.find(capture => capture.evidence.producerSessionId === released.id)
  assert.ok(peer.evidence.completedTurnId)
  assert.ok(peer.evidence.flushedAt >= peer.evidence.completedAt)
  assert.deepEqual(record.attempts.find(a => a.nodeId === 'sink').result.outcome.outputs, work.result.outcome.outputs)
})

test('F6 barrier requires completed collaborator release before primary can finish', async t => {
  const released = Promise.withResolvers()
  const order = []
  const h = await teamHarness(t, {
    count: 2,
    earlyReturn: true,
    onMember: async (call, team) => {
      const row = team.roster.find(row => row.id === call.agent.id)
      if (row.logical === 'producer') {
        await released.promise
        assert.equal(h.live.has(order[0].id), false)
        await completeTask(call, team)
      }
      await team.capture(call, { answer: 42 })
      call.finish({ kind: 'completed' }, '')
      if (row.logical !== 'producer') {
        await team.release(call.agent)
        order.push({ event: 'peer-disposed', id: call.agent.id })
        released.resolve()
      } else order.push({ event: 'primary-completed', id: call.agent.id })
    }
  })
  const { refusal, record } = await h.start()
  assert.equal(refusal, undefined)
  assert.deepEqual(
    order.map(entry => entry.event),
    ['peer-disposed', 'primary-completed']
  )
  assert.equal(record.state, 'succeeded')
  assert.equal(record.teamStage.captures.length, 2)
  assert.equal(record.teamStage.attemptId, record.attempts.find(a => a.nodeId === 'work').attemptId)
})

for (const participated of [true, false]) {
  test(`F6 disposal during capture flush requires successful participation: ${participated}`, async t => {
    const flushEntered = Promise.withResolvers()
    const flushOutcome = Promise.withResolvers()
    const released = Promise.withResolvers()
    let peerId,
      delayed = false
    const h = await teamHarness(t, {
      count: 2,
      earlyReturn: true,
      onMember: async (call, team) => {
        const row = team.roster.find(row => row.id === call.agent.id)
        if (row.logical === 'producer') {
          await released.promise
          await completeTask(call, team)
        } else peerId = call.agent.id
        await team.capture(call, { answer: 42 })
        call.finish({ kind: 'completed' }, '')
        if (row.logical !== 'producer') {
          await flushEntered.promise
          await team.release(call.agent)
          assert.equal(h.live.has(call.agent.id), false)
          flushOutcome.resolve(participated)
          released.resolve()
        }
      }
    })
    const nativeFlush = h.ctx.sessions.flush.bind(h.ctx.sessions)
    t.mock.method(h.ctx.sessions, 'flush', async session => {
      const actual = await nativeFlush(session)
      if (session.id !== peerId || delayed) return actual
      delayed = true
      flushEntered.resolve()
      return flushOutcome.promise
    })
    const { refusal, record } = await h.start()
    assert.equal(refusal, undefined)
    assert.equal(delayed, true, 'own completion flush crossed the controlled disposal barrier')
    if (participated) {
      assert.equal(record.state, 'succeeded')
      assert.equal(record.teamStage.captures.length, 2)
    } else {
      noGraphSuccess(record)
      assert.equal(record.teamStage.recovery.code, 'teamstage-flush-unverified')
      assert.equal(record.teamStage.captures, undefined)
    }
  })
}

for (const fault of ['unproven-absence', 'foreign-replacement', 'same-id-recreated', 'later-running', 'late-message', 'incomplete-disposal', 'cancelled']) {
  test(`F6 ${fault} cannot borrow completed-release evidence`, async t => {
    let peer
    const h = await teamHarness(t, {
      count: 2,
      onMember: async (call, team) => {
        const row = team.roster.find(row => row.id === call.agent.id)
        if (row.logical === 'producer') {
          if (fault === 'cancelled') {
            const run = (await records(h)).find(run => run.state === 'running')
            await h.service.cancelRun({ runId: run.runId })
          } else await completeTask(call, team)
        }
        if (row.logical === 'producer' || fault !== 'incomplete-disposal') await team.capture(call, { answer: 42 })
        call.finish({ kind: 'completed' }, '')
      }
    })
    const nativeSpawn = h.team.spawnTeammate
    h.team.spawnTeammate = async (...args) => {
      const result = await nativeSpawn(...args)
      if (h.team.roster.find(row => row.id === result.member.id).logical !== 'producer') {
        peer = h.live.get(result.member.id)
        if (fault === 'incomplete-disposal' || fault === 'cancelled') {
          await h.team.release(peer)
        }
      }
      return result
    }
    const commitCapture = TeamOutputArtifacts.prototype.commitCapture
    t.mock.method(TeamOutputArtifacts.prototype, 'commitCapture', async function (args) {
      const result = await commitCapture.call(this, args)
      if (fault === 'unproven-absence') h.live.delete(peer.id)
      else {
        await h.team.release(peer)
        if (fault === 'foreign-replacement') h.live.set(peer.id, { ...peer })
        if (fault === 'same-id-recreated') {
          const replacement = { ...peer }
          h.live.set(peer.id, replacement)
          await assert.rejects(h.ctx.serial('agent/created', { agent: replacement, source: 'resume' }))
          h.live.delete(peer.id)
        }
        if (fault === 'later-running') {
          peer.status = 'running'
          h.ctx.emit('agent/status', { agent: peer, status: 'running' })
          peer.status = 'idle'
          h.ctx.emit('agent/status', { agent: peer, status: 'idle' })
        }
        if (fault === 'late-message') peer.inject(createUserMessage({ content: [{ type: 'text', text: 'late peer work' }], source: { kind: 'user' } }))
      }
      return result
    })
    const { refusal, record } = await h.start()
    assert.equal(refusal, undefined)
    noGraphSuccess(record)
    assert.equal(record.teamStage.captures?.some(capture => capture.evidence.producerSessionId === peer.id) ?? false, false)
    const kind = record.attempts.find(a => a.nodeId === 'work').result?.outcome.kind
    if (['unproven-absence', 'foreign-replacement', 'same-id-recreated', 'later-running', 'late-message'].includes(fault)) {
      assert.equal(record.state, 'recovery_required')
      assert.equal(record.teamStage.recovery.code, 'teamstage-quiescence-unverified')
    }
    if (fault === 'incomplete-disposal') assert.equal(kind, 'teamstage-structured-output-missing')
  })
}

function noGraphSuccess(record) {
  assert.notEqual(record.state, 'succeeded')
  assert.notEqual(record.teamStage?.state, 'succeeded')
  assert.notEqual(record.attempts.find(a => a.nodeId === 'work')?.state, 'succeeded')
  assert.equal(
    record.attempts.some(a => a.nodeId === 'sink'),
    false,
    'failed Team output never dispatches downstream'
  )
  assert.equal(record.teamStage?.outputAcceptance, undefined)
}

async function completeTask(call, team) {
  for (const action of ['claim', 'complete']) {
    const result = await team.capture(call, { task_id: team.task.id, expected_revision: team.task.revision, action }, 'team_task_update')
    assert.equal(result.isError, false, 'fixture native mutation must actually execute')
  }
}

test('successful native member task mutations persist their revision before the next model operation', async t => {
  let h
  const observed = []
  h = await teamHarness(t, {
    onMember: async (call, team) => {
      for (const action of ['claim', 'complete']) {
        const result = await team.capture(call, { task_id: team.task.id, expected_revision: team.task.revision, action }, 'team_task_update')
        assert.equal(result.isError, false, 'native task CAS must actually succeed')
        const current = (await records(h)).find(record => record.state === 'running')
        observed.push({
          action,
          nativeRevision: team.task.revision,
          canonicalRevision: current.teamStage.taskRevision,
          resultRevision: current.teamStage.effects.findLast(effect => effect.kind === 'task-update').resultTaskRevision
        })
      }
      await team.capture(call, { answer: 42 })
      call.finish({ kind: 'completed' }, '')
    }
  })
  const { record } = await h.start()
  assert.equal(record.state, 'succeeded')
  assert.deepEqual(observed, [
    { action: 'claim', nativeRevision: 2, canonicalRevision: 2, resultRevision: 2 },
    { action: 'complete', nativeRevision: 3, canonicalRevision: 3, resultRevision: 3 }
  ])
})

for (const fault of ['foreign-id', 'revision-gap', 'wrong-status']) {
  test(`native member task result ${fault} cannot advance canonical revision or claim a known effect`, async t => {
    const h = await teamHarness(t, {
      onMember: async (call, team) => {
        await team.capture(call, { task_id: team.task.id, expected_revision: team.task.revision, action: 'claim' }, 'team_task_update')
        call.finish({ kind: 'completed' }, '')
      }
    })
    const update = h.team.updateTask.bind(h.team)
    h.team.updateTask = async (...args) => {
      const value = await update(...args)
      return {
        ...value,
        ...(fault === 'foreign-id' ? { id: 'foreign-task' } : fault === 'revision-gap' ? { revision: value.revision + 1 } : { status: 'completed' })
      }
    }
    const { record } = await h.start()
    noGraphSuccess(record)
    assert.equal(h.team.task.revision, 2, 'native claim really took effect before the malformed result')
    assert.equal(record.teamStage.taskRevision, 1, 'unverified returned revision cannot become canonical')
    assert.equal(record.state, 'recovery_required')
    assert.ok(record.teamStage.effects.some(effect => effect.kind === 'task-update' && effect.state === 'recovery_required'))
  })
}

test('native spawn may return running: completed capture later produces active/inactive canonical evidence', async t => {
  const h = await teamHarness(t, { earlyReturn: true })
  const { refusal, record } = await h.start()
  assert.equal(refusal, undefined)
  assert.equal(record.state, 'succeeded')
  assert.equal(record.teamStage.members[0].status, 'inactive')
  assert.equal(record.teamStage.members[0].phase, 'active')
  assert.ok(record.teamStage.members[0].evidence)
  assert.equal(record.teamStage.captures.length, 1)
  const reservation = record.teamStage.reservations[0]
  assert.equal(reservation.memberId, record.teamStage.primaryMemberId)
  assert.notEqual(reservation.memberId, reservation.sessionId, 'reserved member identity is never replaced with native child session')
})

test('native provider registration after plugin apply unlocks only a new valid sourced admission', async t => {
  const h = await teamHarness(t, { providers: false })
  const blocked = await h.start()
  assert.equal(blocked.refusal.code, 'blueprint/preflight-blocked')
  assert.ok(blocked.refusal.details.checks.some(c => c.code === 'teamstage-provider-unavailable'))
  assert.deepEqual(h.team.calls, [])
  assert.deepEqual(await records(h), [])
  h.providerMap.set('spawn', { name: 'spawn', inheritsParentContext: false, prepareContinuable() {} })
  const admitted = await h.service.startSessionRun({ ...blocked.startArgs, requestId: randomUUID() })
  await drain(h)
  assert.equal((await records(h)).find(run => run.runId === admitted.runId).state, 'succeeded')
})

for (const badProvider of [
  { name: 'spawn', inheritsParentContext: false },
  { name: 'spawn', inheritsParentContext: true, prepareContinuable() {} }
]) {
  test(`native fresh admission rejects ${badProvider.prepareContinuable ? 'fork-context provider' : 'one-shot-only provider'} before any Run/effect`, async t => {
    const h = await teamHarness(t)
    h.providerMap.set('spawn', badProvider)
    const { refusal } = await h.start()
    assert.equal(refusal.code, 'blueprint/preflight-blocked')
    assert.ok(refusal.details.checks.some(c => c.code === 'teamstage-provider-unavailable'))
    assert.deepEqual(h.team.calls, [])
    assert.deepEqual(await records(h), [])
  })
}

test('unknown configured check blocks production admission without self-certified labels', async t => {
  const h = await teamHarness(t)
  const value = teamDefinition()
  value.graph.nodes[0].teamStage.requiredChecks = ['invented-check']
  const { refusal } = await h.start(value)
  assert.equal(refusal.code, 'blueprint/preflight-blocked')
  assert.ok(refusal.details.checks.some(c => c.code === 'teamstage-check-unavailable'))
  assert.deepEqual(h.team.calls, [])
  assert.deepEqual(await records(h), [])
})

test('source native membership must be the same exact existing root Lead', async t => {
  const h = await teamHarness(t)
  const nativeMembership = h.team.membership
  h.team.membership = agent => ({ ...nativeMembership(agent), role: 'teammate' })
  const { refusal } = await h.start()
  assert.equal(refusal.code, 'blueprint/preflight-blocked')
  assert.deepEqual(refusal.details.checks, [{ code: 'teamstage-identity-unavailable', status: 'block', nodeId: 'work' }])
  assert.deepEqual(h.team.calls, [])
  assert.deepEqual(await records(h), [])
})

test('creation rejects stale registry child before first prompt, without installing capture', async t => {
  const h = await teamHarness(t)
  h.ctx.on('agent/created', ({ agent }) => {
    if (agent !== h.rootAgent) h.live.set(agent.id, { ...agent })
  })
  const { refusal, record } = await h.start()
  assert.equal(refusal, undefined, 'valid admission proceeds to native creation oracle')
  noGraphSuccess(record)
  assert.equal(record.state, 'recovery_required')
  assert.equal(h.team.pendingPrompts.length, 0, 'creation veto runs before prompt delivery')
  assert.equal(h.host.calls[1].agent.ctx.tools.get('structured_output'), undefined)
})

for (const fault of ['create', 'spawn']) {
  test(`generic native ${fault} exception stays unknown and exact admission replay never redispatches`, async t => {
    const h = await teamHarness(t, { nativeFault: fault })
    const { refusal, record, startArgs } = await h.start()
    assert.equal(refusal, undefined)
    noGraphSuccess(record)
    assert.equal(record.state, 'recovery_required')
    assert.equal(record.teamStage.state, 'recovery_required')
    assert.equal(record.attempts.find(a => a.nodeId === 'work').state, 'recovery_required')
    assert.ok(record.teamStage.effects.some(effect => effect.state === 'recovery_required'))
    const calls = [...h.team.calls]
    const replay = await h.service.startSessionRun(startArgs)
    assert.equal(replay.replayed, true)
    await drain(h)
    assert.deepEqual(h.team.calls, calls)
    assert.equal((await records(h)).find(r => r.runId === record.runId).seq, record.seq)
  })
}

for (const variant of ['prose', 'invalid', 'provider-error', 'aborted', 'no-end']) {
  test(`member ${variant} cannot satisfy native capture/completed-turn policy`, async t => {
    const h = await teamHarness(t, {
      onMember: async (call, team) => {
        if (variant === 'invalid') await team.capture(call, { answer: 'wrong type' })
        else if (['provider-error', 'aborted', 'no-end'].includes(variant)) await team.capture(call, { answer: 42 })
        if (variant === 'no-end') call.quiesceWithoutEnd()
        else
          call.finish(
            variant === 'provider-error'
              ? { kind: 'error', error: { code: 'UNKNOWN', message: 'RAW_PROVIDER_SECRET_SENTINEL' } }
              : variant === 'aborted'
                ? { kind: 'aborted', reason: { kind: 'parent' } }
                : { kind: 'completed' },
            variant === 'prose' ? '{"answer":42}' : ''
          )
      }
    })
    const { refusal, record } = await h.start()
    assert.equal(refusal, undefined)
    noGraphSuccess(record)
    assert.equal(record.teamStage.captures, undefined, 'failed turn never produces host artifact')
    const work = record.attempts.find(a => a.nodeId === 'work')
    assert.equal(work.state, variant === 'aborted' ? 'recovery_required' : 'failed')
    if (variant === 'provider-error') assert.equal(work.result.outcome.kind, 'teamstage-provider-failed')
    assert.equal(JSON.stringify(record).includes('RAW_PROVIDER_SECRET_SENTINEL'), false)
  })
}

test('a denied out-of-policy business tool never executes and cannot be hidden by later valid capture', async t => {
  const h = await teamHarness(t, {
    onMember: async (call, team) => {
      const denied = await team.capture(call, {}, 'write_other')
      assert.equal(denied.isError, true)
      await team.capture(call, { answer: 42 })
      call.finish({ kind: 'completed' }, '')
    }
  })
  const { refusal, record } = await h.start()
  assert.equal(refusal, undefined)
  noGraphSuccess(record)
  assert.deepEqual(h.effects, [])
  assert.match(record.attempts.find(a => a.nodeId === 'work').result.outcome.kind, /^teamstage-tool-(rejected|not-permitted)$/)
})

test('scope-local registration and prepended pre-execute cannot widen member permissions', async t => {
  const h = await teamHarness(t, {
    onMember: async (call, team) => {
      let invoked = false
      call.agent.ctx.tools.register({
        name: 'new_business',
        description: 'policy adversary',
        parameters: { type: 'object' },
        output: { schema: { type: 'object' }, render: () => [] },
        async execute() {
          invoked = true
          return {}
        }
      })
      call.agent.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), true)
      const denied = await team.capture(call, {}, 'new_business')
      assert.equal(denied.isError, true)
      assert.equal(invoked, false, 'monotonic scoped guard remains authoritative')
      await team.capture(call, { answer: 42 })
      call.finish({ kind: 'completed' }, '')
    }
  })
  const { record } = await h.start()
  noGraphSuccess(record)
  assert.equal(record.attempts.find(a => a.nodeId === 'work').result.outcome.kind, 'teamstage-tool-not-permitted')
})

for (const denyParent of [false, true]) {
  test(`PTC nested native capture ${denyParent ? 'outer rejected' : 'outer authoritative success'} uses actual root-call provenance`, async t => {
    let nestedRan = false
    let outerResult
    const h = await teamHarness(t, {
      mode: 'both',
      ptcRun: async request => {
        assert.equal(request.cwd, h.rootDir, 'native PTC receives the owned fixture working directory')
        await request.bindings.find(binding => binding.global === 'tools').functions.structured_output({ answer: 42 })
        nestedRan = true
        return { logs: [], value: 'submitted' }
      },
      onMember: async (call, team) => {
        await completeTask(call, team)
        outerResult = await team.capture(call, { description: 'structured native result', code: 'return tools.structured_output({answer:42})' }, 'run_code')
        call.finish({ kind: 'completed' }, '')
      }
    })
    if (denyParent)
      h.ctx.on('tools/post-execute', exec =>
        exec.name === 'run_code' ? { kind: 'block', feedback: [{ type: 'text', text: 'PTC_OUTER_REJECTED' }] } : { kind: 'accept' }
      )
    const { refusal, record } = await h.start()
    assert.equal(refusal, undefined)
    assert.equal(outerResult.isError, denyParent, JSON.stringify(outerResult.content))
    assert.equal(nestedRan, true, 'actual SDK structured sub-dispatch ran')
    if (denyParent) {
      noGraphSuccess(record)
      assert.equal(record.teamStage.captures, undefined)
    } else {
      assert.equal(record.state, 'succeeded')
      const evidence = record.teamStage.captures[0].evidence
      const events = h.team.pendingPrompts[0].agent.session.snapshotEvents()
      const root = events.find(event => event.type === 'tool/call' && event.data.name === 'run_code')
      const leaf = events.find(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'structured_output')
      assert.ok(root, 'outer run_code call was logged by the public native boundary')
      assert.ok(leaf, 'actual structured SDK sub-dispatch has durable native lineage')
      assert.equal(leaf.data.isError, false)
      assert.equal(evidence.rootCallId, root.data.callId)
      assert.equal(evidence.rootCallId, leaf.data.rootCallId)
      assert.equal(evidence.callId, leaf.data.subCallId)
      assert.notEqual(evidence.callId, evidence.rootCallId)
      assert.ok(evidence.captureLogSeq > evidence.startLogSeq)
      assert.ok(evidence.endLogSeq > evidence.captureLogSeq)
    }
  })
}

test('all members must agree on verified values, primary arrival alone never succeeds', async t => {
  const h = await teamHarness(t, {
    count: 2,
    onMember: async (call, team) => {
      const row = team.roster.find(row => row.id === call.agent.id)
      if (row.logical === 'producer') await completeTask(call, team)
      await team.capture(call, { answer: row.logical === 'producer' ? 42 : 7 })
      call.finish({ kind: 'completed' }, '')
    }
  })
  const { record } = await h.start()
  noGraphSuccess(record)
  assert.equal(record.teamStage.captures.length, 2, 'both real host fixture captures exist before agreement rejects')
  assert.equal(record.state, 'failed')
  assert.match(record.attempts.find(a => a.nodeId === 'work').result.outcome.kind, /agreement/)
})

test('member instructions and resource digests use immutable node/member bytes despite live package edits', async t => {
  const h = await teamHarness(t, { count: 2 })
  const originalCreate = h.team.createTask
  h.team.createTask = async (...args) => {
    writeFileSync(join(h.rootDir, 'lib/agents/primary.md'), 'EDIT_AFTER_FREEZE_PRIMARY')
    writeFileSync(join(h.rootDir, 'lib/agents/peer.md'), 'EDIT_AFTER_FREEZE_PEER')
    return originalCreate(...args)
  }
  const { record } = await h.start()
  assert.equal(record.state, 'succeeded')
  for (const prompt of h.team.pendingPrompts) {
    const text = JSON.stringify(prompt.request.prompt)
    assert.equal(text.includes('EDIT_AFTER_FREEZE'), false)
  }
  for (const reservation of record.teamStage.reservations) {
    assert.ok(reservation.resourceDigests.worker)
    assert.ok(reservation.resourceDigests.answerSchema)
    assert.ok(reservation.resourceDigests[reservation.logicalName === 'producer' ? 'primaryAgent' : 'peerAgent'])
  }
})

test('Team preparation snapshots shared Skill exactly once for all members and materializes captured bytes', async t => {
  const h = await teamHarness(t, { count: 2 })
  const skillRoot = join(h.root, 'isolated-skills')
  const skillDir = join(skillRoot, 'shared-review')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '# Shared immutable Skill')
  writeFileSync(join(skillDir, 'payload.txt'), 'original skill payload')
  const value = teamDefinition(2)
  value.resources.shared = { kind: 'skill', source: { kind: 'shared', rootId: 'isolated', path: 'shared-review' } }
  value.graph.nodes[0].skillRefs = ['shared']
  let reads = 0
  const snapshots = new RuntimeSnapshots(h.runtimeRoot, () => {
    reads++
    return [{ rootId: 'isolated', rootPath: skillRoot }]
  })
  await snapshots.freezePackage('isolated-run', value, h.rootDir)
  const prepared = await snapshots.prepareTeam('isolated-run', value, value.graph.nodes[0])
  assert.equal(reads, 1)
  assert.equal(prepared.members[0].resourceDigests.shared, prepared.members[1].resourceDigests.shared)
  writeFileSync(join(skillDir, 'payload.txt'), 'later changed live bytes')
  const cwd = prepared.materialize('isolated-attempt')
  assert.equal(readFileSync(join(cwd, '.blueprint-skills/0/payload.txt'), 'utf8'), 'original skill payload')
  assert.equal(reads, 1)
})

test('scoped native Team tools absent globally remain available on exact source and child at production admission', async t => {
  const h = await teamHarness(t)
  for (const name of ['send_message', 'list_agents', 'wait_agent', 'team_task_list', 'team_task_get', 'team_task_update']) {
    assert.equal(h.nativeTools.get(name), undefined, 'global view must not be used to authenticate native Agent tools')
    assert.ok(h.nativeTools.get(name, h.rootAgent), 'exact root scope has native tool')
  }
  const { refusal, record } = await h.start()
  t.diagnostic(JSON.stringify({ checks: refusal?.details?.checks, nativeCalls: h.team.calls }))
  assert.equal(refusal, undefined, 'scoped-only native Team tools must pass production admission')
  assert.equal(record.state, 'succeeded')
  for (const name of ['team_task_get', 'team_task_update']) assert.ok(h.nativeTools.get(name, h.team.pendingPrompts[0].agent))
})

test('source scoped capability does not substitute for absent native tools on the created child', async t => {
  const h = await teamHarness(t, { childTools: false })
  const { refusal, record } = await h.start()
  assert.equal(refusal, undefined)
  noGraphSuccess(record)
  assert.equal(record.state, 'recovery_required')
  assert.equal(h.team.pendingPrompts.length, 0)
  assert.equal(h.nativeTools.get('structured_output', h.host.calls[1].agent), undefined)
})

test('native Team message uses the actual registered peer and a durable member-owned effect', async t => {
  const h = await teamHarness(t, {
    count: 2,
    onMember: async (call, team) => {
      const row = team.roster.find(row => row.id === call.agent.id)
      if (row.logical === 'producer') {
        const peer = team.roster.find(row => row.logical !== 'producer')
        assert.ok(peer)
        const result = await team.capture(call, { target: peer.name, message: 'agreed answer is 42' }, 'send_message')
        assert.equal(result.isError, false)
        await completeTask(call, team)
      }
      await team.capture(call, { answer: 42 })
      call.finish({ kind: 'completed' }, '')
    }
  })
  const { record } = await h.start()
  assert.equal(record.state, 'succeeded')
  assert.equal(h.team.calls.filter(c => c === 'message').length, 1)
  const message = record.teamStage.effects.find(effect => effect.kind === 'message')
  assert.equal(message.state, 'succeeded')
  const producer = record.teamStage.members.find(m => m.memberId === record.teamStage.primaryMemberId)
  assert.equal(message.actorSessionId, producer.sessionId)
  assert.equal(message.memberId, producer.memberId)
  assert.equal(message.taskId, record.teamStage.taskId)
})

test('native member mutation error after dispatch remains canonical unknown, never ordinary failed/replayed', async t => {
  const h = await teamHarness(t, {
    onMember: async (call, team) => {
      const result = await team.capture(call, { task_id: team.task.id, expected_revision: team.task.revision, action: 'claim' }, 'team_task_update')
      assert.equal(result.isError, true)
      call.finish({ kind: 'completed' }, '')
    }
  })
  h.team.updateTask = async () => {
    throw new Error('ambiguous native append before flush')
  }
  const { record, startArgs } = await h.start()
  noGraphSuccess(record)
  assert.equal(record.state, 'recovery_required')
  assert.ok(record.teamStage.effects.some(effect => effect.kind === 'task-update' && effect.state === 'recovery_required'))
  const calls = [...h.team.calls]
  await h.service.startSessionRun(startArgs)
  await drain(h)
  assert.deepEqual(h.team.calls, calls)
})

test('cancelled production Team capture never becomes accepted, and source Lead is untouched', async t => {
  let h
  h = await teamHarness(t, {
    onMember: async (call, team) => {
      const active = (await records(h)).find(record => record.state === 'running')
      assert.ok(active)
      await h.service.cancelRun({ runId: active.runId })
      const result = await team.capture(call, { answer: 42 })
      assert.equal(result.isError, true, 'aborted stage scope blocks late capture')
      call.finish({ kind: 'aborted', reason: { kind: 'parent' } }, '')
    }
  })
  const { record } = await h.start()
  noGraphSuccess(record)
  assert.equal(record.state, 'recovery_required', 'complete owned drain/task cancel belongs to W2.7.3')
  assert.equal(record.attempts.find(a => a.nodeId === 'work').state, 'recovery_required')
  assert.equal(h.rootAgent.status, 'idle')
  assert.deepEqual(h.host.calls[0].injections, [])
})

test('unknown member mutation immediately stops further native dispatch in the same model turn', async t => {
  let nativeInvocations = 0
  const h = await teamHarness(t, {
    onMember: async (call, team) => {
      for (let i = 0; i < 2; i++) {
        const result = await team.capture(call, { task_id: team.task.id, expected_revision: team.task.revision, action: 'claim' }, 'team_task_update')
        assert.equal(result.isError, true)
      }
      call.finish({ kind: 'completed' }, '')
    }
  })
  h.team.updateTask = async () => {
    nativeInvocations++
    throw new Error('native append/flush rejected ambiguously')
  }
  const { record } = await h.start()
  assert.equal(nativeInvocations, 1, 'unknown external mutation must not be attempted again, even inside the original turn')
  noGraphSuccess(record)
  assert.equal(record.state, 'recovery_required')
  assert.equal(record.teamStage.effects.filter(effect => effect.kind === 'task-update').length, 1)
})

test('public native SpawnTeammateResult member wrapper preserves exact child/name through capture settlement', async t => {
  const h = await teamHarness(t)
  const spawn = h.team.spawnTeammate.bind(h.team)
  let returned
  h.team.spawnTeammate = async (...args) => {
    returned = await spawn(...args)
    return returned
  }
  const { refusal, record } = await h.start()
  assert.equal(refusal, undefined)
  assert.deepEqual(Object.keys(returned), ['member'], 'public native API wraps the TeamMemberView')
  assert.equal(returned.member.id, h.team.pendingPrompts[0].agent.id)
  assert.equal(returned.member.name, h.team.pendingPrompts[0].request.name)
  t.diagnostic(JSON.stringify({ state: record.state, nativeCalls: h.team.calls, returnKeys: Object.keys(returned) }))
  assert.equal(record.state, 'succeeded', 'actual public wrapper must settle the same graph Attempt')
  const producer = record.teamStage.members.find(member => member.memberId === record.teamStage.primaryMemberId)
  assert.equal(producer.sessionId, returned.member.id)
  assert.equal(producer.name, returned.member.name)
})

for (const [kind, corrupt] of [
  ['flat view', result => result.member],
  ['missing member', () => ({})],
  ['array member', () => ({ member: [] })],
  ['foreign child', result => ({ member: { ...result.member, id: SessionId(randomUUID()) } })],
  ['foreign native name', result => ({ member: { ...result.member, name: `bp-${randomUUID()}` } })]
]) {
  test(`public native SpawnTeammateResult rejects ${kind} without weakening exact identity or replaying spawn`, async t => {
    const h = await teamHarness(t)
    const spawn = h.team.spawnTeammate.bind(h.team)
    h.team.spawnTeammate = async (...args) => corrupt(await spawn(...args))
    const { refusal, record, startArgs } = await h.start()
    assert.equal(refusal, undefined, 'admission succeeds; the malformed native response reaches the real driver')
    assert.deepEqual(h.team.calls, ['create', 'spawn', 'claim', 'complete'], 'native child completed before its return was rejected')
    noGraphSuccess(record)
    assert.equal(record.state, 'recovery_required')
    const effect = record.teamStage.effects.find(effect => effect.kind === 'spawn')
    assert.equal(effect.state, 'recovery_required', 'post-dispatch identity mismatch has unknown external outcome')
    assert.equal(record.log.at(-1).detail.reason, 'teamstage-member-identity-unavailable')
    assert.equal(record.teamStage.captures, undefined)
    const calls = [...h.team.calls]
    await h.service.startSessionRun(startArgs)
    await drain(h)
    assert.deepEqual(h.team.calls, calls, 'replay never creates a replacement native child')
  })
}
