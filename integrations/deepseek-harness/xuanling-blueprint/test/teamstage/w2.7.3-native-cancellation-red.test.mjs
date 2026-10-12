import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'
import { cancelOwnedTeamStage } from '../../src/teamstage/cancellation.ts'
import { TeamEffectUnknownError, recordTeamEffectIntent, recordTeamEffectResult } from '../../src/teamstage/runner.ts'

const digest = value => createHash('sha256').update(value).digest('hex')
let fixtureNumber = 0

const lead = { agent: { id: 'lead-session' }, teamId: 'team-owned', service: {} }

async function fixture(t, { members, taskRevision } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'xuanling-w273-'))
  const opened = await openBlueprintDomain({ backend: 'json', path: join(root, 'store') })
  const store = new RunStore(opened.domain)
  const { runId } = await store.createRun(
    { scope: 'teamstage', requestId: `w2-7-3-${fixtureNumber++}`, payloadFingerprint: digest(root) },
    'revision-1',
    '{}',
    '{}',
  )
  await store.bindTeamStage(runId, {
    stageId: 'stage-owned',
    teamId: 'team-owned',
    leadSessionId: 'lead-session',
    taskSpecificationFingerprint: digest('task-owned'),
  })
  await store.updateTeamStage(runId, { members })
  if (taskRevision !== undefined) await store.bindTeamTask(runId, { taskId: 'task-owned', taskRevision })
  t.after(async () => {
    await opened.close()
    await rm(root, { recursive: true, force: true })
  })
  return { store, runId }
}

async function persistentFixture(t, backend) {
  const root = await mkdtemp(join(tmpdir(), `xuanling-w273-reopen-${backend}-`))
  const path = backend === 'json' ? join(root, 'store') : join(root, 'store', 'runs.sqlite')
  let opened
  let store
  const open = async () => {
    await mkdir(join(root, 'store'), { recursive: true })
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
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }) })
  await open()
  const { runId } = await store.createRun(
    { scope: 'teamstage', requestId: `w2-7-3-reopen-${backend}`, payloadFingerprint: digest(root) },
    'revision-1', '{}', '{}',
  )
  await store.bindTeamStage(runId, {
    stageId: 'stage-owned', teamId: 'team-owned', leadSessionId: 'lead-session', taskSpecificationFingerprint: digest('task-owned'),
  })
  await store.updateTeamStage(runId, { members: [member('owned-a', 'child-a', 'inactive')] })
  await store.bindTeamTask(runId, { taskId: 'task-owned', taskRevision: 7 })
  return { get store() { return store }, runId, reopen }
}

const member = (name, sessionId, status = 'inactive') => ({
  memberId: `member-${name}`,
  name,
  sessionId,
  phase: 'active',
  status,
})

test('W2.7.3 empty memberNames derives the complete canonical owned set', async t => {
  const { store, runId } = await fixture(t, {
    members: [member('owned-a', 'child-a'), member('owned-b', 'child-b')],
  })
  const interrupted = []
  const drained = []
  const foreign = { touched: false, sessionId: 'foreign-child' }
  const result = await cancelOwnedTeamStage({
    store,
    runId,
    adapter: {
      interrupt: (_lead, name) => { interrupted.push(name); return { previousStatus: 'inactive' } },
      drainChildren: (_lead, childIds) => { drained.push([...childIds]); return undefined },
    },
    lead,
    memberNames: [],
  })

  assert.deepEqual(interrupted, ['owned-a', 'owned-b'], 'empty public target is only a consistency check')
  assert.deepEqual(drained, [['child-a', 'child-b']])
  assert.equal(foreign.touched, false)
  assert.equal(result.teamStage.state, 'cancelled')
})

test('W2.7.3 a subset memberNames cannot shrink the canonical owned set', async t => {
  const { store, runId } = await fixture(t, {
    members: [member('owned-a', 'child-a'), member('owned-b', 'child-b')],
  })
  const interrupted = []
  const drained = []
  const foreign = { touched: false, sessionId: 'foreign-child' }
  const result = await cancelOwnedTeamStage({
    store,
    runId,
    adapter: {
      interrupt: (_lead, name) => { interrupted.push(name); return { previousStatus: 'inactive' } },
      drainChildren: (_lead, childIds) => { drained.push([...childIds]); return undefined },
    },
    lead,
    ownedMemberNames: ['owned-a'],
  })

  assert.deepEqual(interrupted, ['owned-a', 'owned-b'], 'subset target is only a consistency check')
  assert.deepEqual(drained, [['child-a', 'child-b']])
  assert.equal(foreign.touched, false)
  assert.equal(result.teamStage.state, 'cancelled')
})

test('W2.7.3 running child uses targeted drain and does not drain foreign children', async t => {
  const { store, runId } = await fixture(t, {
    members: [member('owned-a', 'child-a', 'running')],
    taskRevision: 7,
  })
  const interrupted = []
  const drained = []
  const foreign = { touched: false, sessionId: 'foreign-child' }
  const result = await cancelOwnedTeamStage({
    store,
    runId,
    adapter: {
      interrupt: (_lead, name) => { interrupted.push(name); return { previousStatus: 'running' } },
      drainChildren: (_lead, childIds) => {
        drained.push([...childIds])
        assert.deepEqual(childIds, ['child-a'])
        return undefined
      },
      updateTask: (_lead, request) => ({ id: request.taskId, revision: request.expectedRevision + 1, status: 'deleted' }),
    },
    lead,
    memberNames: ['owned-a'],
  })

  assert.deepEqual(interrupted, ['owned-a'])
  assert.deepEqual(drained, [['child-a']], 'running child requires exact targeted drain')
  assert.equal(foreign.touched, false)
  assert.equal(result.teamStage.state, 'cancelled')
})

test('W2.7.3 Lead deletes the canonical task by expected-revision CAS', async t => {
  const { store, runId } = await fixture(t, {
    members: [member('owned-a', 'child-a')],
    taskRevision: 7,
  })
  const taskUpdates = []
  const unrelatedTask = { id: 'task-unrelated', revision: 19, status: 'in_progress' }
  const result = await cancelOwnedTeamStage({
    store,
    runId,
    adapter: {
      interrupt: () => ({ previousStatus: 'inactive' }),
      getTask: (_lead, taskId) => ({ id: taskId, revision: 7, status: 'in_progress' }),
      updateTask: (_lead, request) => {
        taskUpdates.push({ ...request })
        return { id: request.taskId, revision: request.expectedRevision + 1, status: 'deleted' }
      },
    },
    lead,
    memberNames: ['owned-a'],
  })

  assert.deepEqual(taskUpdates, [{ taskId: 'task-owned', expectedRevision: 7, action: 'delete' }])
  assert.equal(unrelatedTask.status, 'in_progress')
  assert.equal(result.teamStage.state, 'cancelled')
})

test('W2.7.3 unknown targeted drain settles recovery and never replays', async t => {
  const { store, runId } = await fixture(t, {
    members: [member('owned-a', 'child-a')],
  })
  let drainCalls = 0
  let interruptCalls = 0
  const result = await cancelOwnedTeamStage({
    store,
    runId,
    adapter: {
      interrupt: () => { interruptCalls++; return { previousStatus: 'inactive' } },
      drainChildren: () => {
        drainCalls++
        throw new TeamEffectUnknownError()
      },
    },
    lead,
    memberNames: ['owned-a'],
  })

  assert.equal(interruptCalls, 1)
  assert.equal(drainCalls, 1)
  assert.equal(result.teamStage.state, 'recovery_required')
  assert.equal(result.teamStage.recovery.code, 'team-effect-unknown')
  assert.equal(interruptCalls, 1, 'unknown drain must not redispatch the child')
})

for (const backend of ['json', 'sqlite']) {
  test(`W2.7.3 ${backend} reopen skips already-succeeded cancellation effects`, async t => {
    const h = await persistentFixture(t, backend)
    await h.store.requestCancel(h.runId)

    const drain = {
      runId: h.runId, stageId: 'stage-owned', teamId: 'team-owned', effectId: 'cancel-drain:stage-owned',
      kind: 'drain', actorSessionId: 'lead-session',
    }
    await recordTeamEffectIntent(h.store, drain)
    await recordTeamEffectResult(h.store, drain, { ok: true, status: 'drained' })

    const taskDelete = {
      runId: h.runId, stageId: 'stage-owned', teamId: 'team-owned', effectId: 'cancel-task-delete:task-owned:7',
      kind: 'task-delete', actorSessionId: 'lead-session', taskId: 'task-owned',
    }
    await recordTeamEffectIntent(h.store, taskDelete)
    await recordTeamEffectResult(h.store, taskDelete, {
      ok: true, taskId: 'task-owned', taskRevision: 8, status: 'deleted',
    })

    await h.reopen()
    let interrupts = 0
    let drains = 0
    let taskDeletes = 0
    const result = await cancelOwnedTeamStage({
      store: h.store,
      runId: h.runId,
      adapter: {
        interrupt: () => { interrupts++; return { previousStatus: 'inactive' } },
        drainChildren: () => { drains++; },
        updateTask: () => { taskDeletes++; throw new Error('succeeded task-delete must not replay') },
      },
      lead,
      memberNames: [],
    })

    assert.equal(result.teamStage.state, 'cancelled')
    assert.equal(interrupts, 1)
    assert.equal(drains, 0, 'a succeeded drain effect is a durable replay barrier')
    assert.equal(taskDeletes, 0, 'a succeeded task delete is a durable replay barrier')
    assert.equal(result.teamStage.effects.find(effect => effect.effectId === drain.effectId)?.state, 'succeeded')
    assert.equal(result.teamStage.effects.find(effect => effect.effectId === taskDelete.effectId)?.resultTaskRevision, 8)
  })
}

for (const [label, response] of [
  ['wrong-id', request => ({ id: 'foreign-task', revision: request.expectedRevision + 1, status: 'deleted' })],
  ['wrong-revision', request => ({ id: request.taskId, revision: request.expectedRevision + 2, status: 'deleted' })],
  ['wrong-status', request => ({ id: request.taskId, revision: request.expectedRevision + 1, status: 'completed' })],
  ['malformed', () => null],
]) {
  test(`W2.7.3 task delete ${label} enters recovery without accepting a false tombstone`, async t => {
    const { store, runId } = await fixture(t, { members: [member('owned-a', 'child-a')], taskRevision: 7 })
    let calls = 0
    const result = await cancelOwnedTeamStage({
      store,
      runId,
      adapter: {
        interrupt: () => ({ previousStatus: 'inactive' }),
        updateTask: (_lead, request) => { calls++; return response(request) },
      },
      lead,
      memberNames: ['owned-a'],
    })
    assert.equal(calls, 1)
    assert.equal(result.teamStage.state, 'recovery_required')
    assert.equal(result.teamStage.recovery.code, 'team-effect-unknown')
    assert.equal(result.teamStage.effects.find(effect => effect.kind === 'task-delete')?.state, 'recovery_required')
  })
}
