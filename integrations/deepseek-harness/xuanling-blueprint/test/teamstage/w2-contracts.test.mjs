import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBlueprintDomain, DurabilityFailureError, RunStore } from '../../src/persistence/index.ts'
import { TeamNativeAdapter, TeamIdentityUnavailableError, TeamCapabilityUnavailableError, memberSnapshot } from '../../src/teamstage/native-adapter.ts'
import { createBoundTeamTask, updateBoundTeamTask } from '../../src/teamstage/task-binding.ts'
import { spawnBoundTeamMember } from '../../src/teamstage/member-binding.ts'
import { TeamStageRunner, TeamEffectUnknownError, recordTeamEffectIntent } from '../../src/teamstage/runner.ts'
import { cancelOwnedTeamStage } from '../../src/teamstage/cancellation.ts'
import { acceptTeamOutput, TeamAcceptanceRejectedError } from '../../src/teamstage/acceptance.ts'
import { projectTeamStage } from '../../src/conversation/run-projection.ts'
import { teamOutputAcceptanceSchema, teamStageRecordSchema } from '../../src/persistence/records.ts'

const digest = value => createHash('sha256').update(value).digest('hex')
const request = id => ({ scope: 'teamstage', requestId: id, payloadFingerprint: digest(id) })
let fixtureNumber = 0

async function fixture(t, members = [], options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'xuanling-w2-'))
  const opened = await openBlueprintDomain({ backend: 'json', path: join(root, 'store') })
  const store = new RunStore(opened.domain)
  const { runId } = await store.createRun(request(`run-${fixtureNumber++}`), 'rev-1', '{}', '{}')
  const attempt = options.attempt === true ? await store.recordIntent(runId, { nodeId: 'stage-1', kind: 'agentTask' }) : undefined
  await store.bindTeamStage(runId, {
    stageId: 'stage-1',
    teamId: 'team-1',
    leadSessionId: 'lead',
    taskSpecificationFingerprint: digest('task'),
    ...(attempt === undefined
      ? {}
      : { attemptId: attempt.attemptId, requiredMemberIds: members.map(member => member.memberId), primaryMemberId: members[0]?.memberId })
  })
  if (members.length > 0) await store.updateTeamStage(runId, { members })
  t.after(async () => {
    await opened.close()
    await rm(root, { recursive: true, force: true })
  })
  return { store, runId, attemptId: attempt?.attemptId }
}

test('W2 C-01 uses exact live Agent.id identity and rejects stale, teammate, descriptor, unavailable', () => {
  const lead = { id: 'lead' }
  const teammate = { id: 'child' }
  const descriptor = { id: 'descriptor-child' }
  const live = new Map([
    ['lead', lead],
    ['child', teammate],
    ['descriptor-child', descriptor]
  ])
  const service = {
    membership(agent) {
      return agent === lead ? { root: lead, id: 'team-1', role: 'lead', name: 'lead' } : { root: lead, id: 'team-1', role: 'teammate', name: 'worker' }
    },
    listMembers() {
      return []
    },
    spawnTeammate() {
      return Promise.resolve({})
    },
    sendMessage() {
      return Promise.resolve({})
    },
    createTask() {
      return Promise.resolve({ id: 'task-1', revision: 1 })
    },
    getTask() {
      return { id: 'task-1', revision: 1 }
    },
    listTasks() {
      return []
    },
    updateTask() {
      return Promise.resolve({ id: 'task-1', revision: 2 })
    },
    waitForChange() {
      return Promise.resolve({ timedOut: true })
    },
    interrupt() {
      return { previousStatus: 'running' }
    }
  }
  const adapter = new TeamNativeAdapter({ agents: { get: id => live.get(id) }, agentTeams: service })
  assert.equal(adapter.lead(lead).teamId, 'team-1')
  assert.throws(() => adapter.lead({ id: 'lead' }), TeamIdentityUnavailableError)
  assert.throws(() => adapter.lead(teammate), TeamIdentityUnavailableError)
  assert.throws(() => adapter.lead(descriptor), TeamIdentityUnavailableError)
  assert.throws(() => new TeamNativeAdapter({ agents: { get: id => live.get(id) } }).lead(lead), TeamCapabilityUnavailableError)
})

test('W2.7.3 every native Team operation revalidates the exact live Lead handle', async () => {
  const lead = { id: 'lead' }
  const live = new Map([['lead', lead]])
  const service = {
    membership(agent) {
      return { root: agent, id: 'team-1', role: 'lead', name: 'lead' }
    },
    listMembers() {
      return []
    },
    spawnTeammate() {
      return Promise.resolve({})
    },
    sendMessage() {
      return Promise.resolve({})
    },
    createTask() {
      return Promise.resolve({ id: 'task-1', revision: 1 })
    },
    getTask() {
      return { id: 'task-1', revision: 1 }
    },
    listTasks() {
      return []
    },
    updateTask() {
      return Promise.resolve({ id: 'task-1', revision: 2 })
    },
    waitForChange() {
      return Promise.resolve({ timedOut: true })
    },
    interrupt() {
      return { previousStatus: 'inactive' }
    }
  }
  const adapter = new TeamNativeAdapter({ agents: { get: id => live.get(id) }, agentTeams: service })
  const handle = adapter.lead(lead)
  live.set('lead', { id: 'lead' })

  assert.throws(() => adapter.listMembers(handle), TeamIdentityUnavailableError)
  assert.throws(() => adapter.getTask(handle, 'task-1'), TeamIdentityUnavailableError)
  assert.throws(() => adapter.listTasks(handle), TeamIdentityUnavailableError)
  assert.throws(() => adapter.interrupt(handle, 'worker'), TeamIdentityUnavailableError)
  await assert.rejects(
    () =>
      adapter.spawnTeammate(handle, {
        name: 'worker',
        description: 'worker',
        prompt: [],
        context: 'fresh',
        provider: 'p',
        signal: new AbortController().signal
      }),
    TeamIdentityUnavailableError
  )
  await assert.rejects(() => adapter.sendMessage(handle, { target: 'worker', content: [], signal: new AbortController().signal }), TeamIdentityUnavailableError)
  await assert.rejects(() => adapter.createTask(handle, { subject: 'subject', description: 'description' }), TeamIdentityUnavailableError)
  await assert.rejects(() => adapter.updateTask(handle, { taskId: 'task-1', expectedRevision: 1, action: 'delete' }), TeamIdentityUnavailableError)
  await assert.rejects(() => adapter.waitForChange(handle, 1, new AbortController().signal), TeamIdentityUnavailableError)
})

test('W2 C-02/C-03 creates revision-one task, updates by CAS, and replays without duplicate create', async t => {
  const { store, runId } = await fixture(t)
  const lead = { agent: { id: 'lead' }, teamId: 'team-1', service: {} }
  let creates = 0
  const native = {
    createTask: async (_lead, req) => {
      creates++
      assert.deepEqual(req, { subject: 'subject', description: 'description' })
      return { id: 'task-1', revision: 1, status: 'pending' }
    },
    getTask: (_lead, id) => ({ id, revision: 1, status: 'pending' }),
    updateTask: async (_lead, req) => {
      assert.equal(req.expectedRevision, 1)
      return { id: 'task-1', revision: 2, status: 'completed' }
    }
  }
  const adapter = { createTask: native.createTask, getTask: native.getTask, updateTask: native.updateTask }
  const first = await createBoundTeamTask({ store, adapter, runId, lead, request: { subject: 'subject', description: 'description' }, effectId: 'create-1' })
  assert.equal(first.revision, 1)
  await createBoundTeamTask({
    store,
    adapter: {
      ...adapter,
      createTask: async () => {
        throw new Error('duplicate create')
      }
    },
    runId,
    lead,
    request: { subject: 'subject', description: 'description' },
    effectId: 'create-1'
  })
  assert.equal(creates, 1)
  const updated = await updateBoundTeamTask({ store, adapter, runId, lead, taskId: 'task-1', expectedRevision: 1, action: 'complete' })
  assert.equal(updated.revision, 2)
  await assert.rejects(
    () => updateBoundTeamTask({ store, adapter, runId, lead, taskId: 'task-1', expectedRevision: 1, action: 'complete' }),
    error => error.code === 'TEAM_TASK_CONFLICT'
  )
  await assert.rejects(
    () => updateBoundTeamTask({ store, adapter, runId, lead, taskId: 'foreign', expectedRevision: 2, action: 'complete' }),
    error => error.code === 'TEAM_TASK_CONFLICT'
  )
})

test('W2 C-02 concurrent task creates reserve one canonical external effect', async t => {
  const { store, runId } = await fixture(t)
  const lead = { agent: { id: 'lead' }, teamId: 'team-1', service: {} }
  let creates = 0
  let release
  let resolveStarted
  const started = new Promise(resolve => {
    resolveStarted = resolve
  })
  const gate = new Promise(resolve => {
    release = resolve
  })
  const adapter = {
    createTask: async () => {
      creates++
      resolveStarted()
      await gate
      return { id: 'task-1', revision: 1, status: 'pending' }
    },
    getTask: (_lead, id) => ({ id, revision: 1, status: 'pending' }),
    updateTask: async (_lead, request) => ({ id: request.taskId, revision: request.expectedRevision + 1, status: 'completed' })
  }
  const first = createBoundTeamTask({ store, adapter, runId, lead, request: { subject: 'subject', description: 'description' }, effectId: 'create-a' })
  await started
  await assert.rejects(
    () => createBoundTeamTask({ store, adapter, runId, lead, request: { subject: 'subject', description: 'description' }, effectId: 'create-b' }),
    error => error.code === 'TEAM_EFFECT_UNKNOWN'
  )
  release()
  await first
  assert.equal(creates, 1)
})

test('W2 C-02 malformed native task responses settle recovery instead of ordinary failure', async t => {
  const { store, runId } = await fixture(t)
  const lead = { agent: { id: 'lead' }, teamId: 'team-1', service: {} }
  await assert.rejects(
    () =>
      createBoundTeamTask({
        store,
        adapter: { createTask: async () => null },
        runId,
        lead,
        request: { subject: 'subject', description: 'description' },
        effectId: 'malformed-create'
      }),
    error => error.code === 'TEAM_TASK_INVALID'
  )
  const record = await store.get(runId)
  assert.equal(record.teamStage.state, 'recovery_required')
  assert.equal(record.teamStage.effects.find(effect => effect.effectId === 'malformed-create')?.state, 'recovery_required')
})

test('W2 C-02 bound task replay rejects foreign native identity and records recovery', async t => {
  const { store, runId } = await fixture(t)
  await store.bindTeamTask(runId, { taskId: 'task-1', taskRevision: 1 })
  const lead = { agent: { id: 'lead' }, teamId: 'team-1', service: {} }
  await assert.rejects(
    () =>
      createBoundTeamTask({
        store,
        adapter: { getTask: () => ({ id: 'foreign-task', revision: 1 }) },
        runId,
        lead,
        request: { subject: 'subject', description: 'description' },
        effectId: 'replay'
      }),
    error => error.code === 'TEAM_TASK_INVALID'
  )
  assert.equal((await store.get(runId)).teamStage.state, 'recovery_required')
})

test('W2 C-04 unknown Team effect is durable recovery and never blindly redispatched', async t => {
  const { store, runId } = await fixture(t)
  const runner = new TeamStageRunner(store)
  const facts = { runId, stageId: 'stage-1', teamId: 'team-1', effectId: 'effect-1', kind: 'spawn', memberName: 'worker-one', actorSessionId: 'lead' }
  await recordTeamEffectIntent(store, facts)
  let dispatched = false
  await assert.rejects(
    () =>
      runner.dispatch({
        ...facts,
        effect: async () => {
          dispatched = true
          return 'duplicate'
        }
      }),
    error => error.code === 'TEAM_EFFECT_UNKNOWN'
  )
  assert.equal(dispatched, false)
  const unknownFacts = { ...facts, effectId: 'effect-2', memberName: 'worker-two' }
  const unknown = await runner
    .dispatch({
      ...unknownFacts,
      effect: async () => {
        throw new TeamEffectUnknownError()
      }
    })
    .catch(error => error)
  assert.equal(unknown.code, 'TEAM_EFFECT_UNKNOWN')
  assert.equal((await store.get(runId)).teamStage.state, 'recovery_required')
  assert.equal(JSON.stringify(await store.get(runId)).includes('must not run'), false)
})

test('W2 C-05 cancellation touches explicit owned names and preserves unrelated sentinel', async t => {
  const { store, runId } = await fixture(t, [
    { memberId: 'owned-worker', name: 'owned-worker', sessionId: 'owned-session', phase: 'active', status: 'inactive' }
  ])
  const interrupted = []
  const adapter = {
    interrupt: (_lead, name) => {
      interrupted.push(name)
      return { previousStatus: 'inactive' }
    }
  }
  const lead = { agent: { id: 'lead' }, teamId: 'team-1', service: {} }
  const cancelled = await cancelOwnedTeamStage({ store, runId, adapter, lead, ownedMemberNames: ['owned-worker'] })
  assert.equal(cancelled.teamStage.state, 'cancelled')
  assert.deepEqual(interrupted, ['owned-worker'])
  assert.equal(interrupted.includes('unrelated-worker'), false)
})

test('W2 C-05 resolves member/session ids to the canonical native teammate name', async t => {
  const { store, runId } = await fixture(t, [
    { memberId: 'owned-worker', name: 'owned-worker', sessionId: 'owned-session', phase: 'active', status: 'inactive' }
  ])
  const interrupted = []
  const result = await cancelOwnedTeamStage({
    store,
    runId,
    adapter: {
      interrupt: (_lead, name) => {
        interrupted.push(name)
        return { previousStatus: 'inactive' }
      }
    },
    lead: { agent: { id: 'lead' }, teamId: 'team-1', service: {} },
    ownedMemberNames: ['owned-session']
  })
  assert.equal(result.teamStage.state, 'cancelled')
  assert.deepEqual(interrupted, ['owned-worker'])
})

test('W2 C-06 cancellation during unresolved effect settles recovery_required', async t => {
  const { store, runId } = await fixture(t)
  await store.updateTeamStage(runId, {
    members: [{ memberId: 'owned-worker', name: 'owned-worker', sessionId: 'owned-session', phase: 'active', status: 'running' }]
  })
  await recordTeamEffectIntent(store, {
    runId,
    stageId: 'stage-1',
    teamId: 'team-1',
    effectId: 'spawn-1',
    kind: 'spawn',
    memberName: 'owned-worker',
    actorSessionId: 'lead'
  })
  const interrupted = []
  const result = await cancelOwnedTeamStage({
    store,
    runId,
    adapter: {
      interrupt: (_lead, name) => {
        interrupted.push(name)
        return { previousStatus: 'running' }
      }
    },
    lead: { agent: { id: 'lead' }, teamId: 'team-1', service: {} },
    ownedMemberNames: ['owned-worker']
  })
  assert.equal(result.teamStage.state, 'recovery_required')
  assert.deepEqual(interrupted, ['owned-worker'])
})

test('W2 C-05/C-06 cancellation and recovery race stays typed for three consecutive runs', async t => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { store, runId } = await fixture(t)
    await recordTeamEffectIntent(store, {
      runId,
      stageId: 'stage-1',
      teamId: 'team-1',
      effectId: `race-${attempt}`,
      kind: 'task-update',
      actorSessionId: 'lead'
    })
    const result = await cancelOwnedTeamStage({ store, runId, ownedMemberNames: [] })
    assert.equal(result.teamStage.state, 'recovery_required')
    assert.equal(result.teamStage.recovery.code, 'team-effect-unknown')
  }
})

test('W2 C-04 acceptance is strict, binds task/source/artifact, and only succeeds completed policy', async t => {
  const members = [
    {
      memberId: 'member-1',
      sessionId: 'member-1',
      phase: 'active',
      status: 'inactive',
      evidence: {
        runId: 'pending',
        stageId: 'stage-1',
        taskId: 'task-1',
        attemptId: 'pending',
        captureId: 'capture',
        schemaDigest: digest('schema'),
        valueDigest: digest('value'),
        completedTurnId: 'turn',
        flushedAt: 1,
        quiescentAt: 2
      }
    }
  ]
  const { store, runId, attemptId } = await fixture(t, members, { attempt: true })
  const storedMember = (await store.get(runId)).teamStage.members[0]
  await store.updateTeamStage(runId, { members: [{ ...storedMember, evidence: { ...storedMember.evidence, runId, attemptId } }] })
  await store.bindTeamTask(runId, { taskId: 'task-1', taskRevision: 1 })
  const accepted = {
    code: 'accepted',
    schemaVersion: 1,
    runId,
    stageId: 'stage-1',
    taskId: 'task-1',
    attemptId,
    sourceSessionId: 'member-1',
    artifactId: 'artifact-1',
    digest: digest('artifact'),
    evidenceDigest: digest('evidence'),
    checks: ['schema', 'digest', 'artifact-digest', 'agreement']
  }
  const hostVerdict = {
    status: 'verified',
    artifactId: 'artifact-1',
    digest: digest('artifact'),
    byteLength: 8,
    schemaDigest: digest('schema'),
    evidenceDigest: digest('evidence'),
    runId,
    stageId: 'stage-1',
    taskId: 'task-1',
    attemptId,
    producerSessionId: 'member-1',
    producerMemberId: 'member-1'
  }
  await assert.rejects(
    () => acceptTeamOutput({ store, runId, output: accepted, task: { id: 'task-1', revision: 1, status: 'in_progress' }, taskStatus: 'in_progress' }),
    TeamAcceptanceRejectedError
  )
  const settled = await acceptTeamOutput({
    store,
    runId,
    output: accepted,
    hostVerdict,
    attemptId,
    outputs: { answer: 'verified' },
    task: { id: 'task-1', revision: 1, status: 'completed' },
    taskStatus: 'completed',
    artifact: { artifactId: 'artifact-1', digest: digest('artifact') }
  })
  assert.equal(settled.teamStage.state, 'succeeded')
  assert.equal(JSON.stringify(settled).includes('raw provider output'), false)
  const seq = (await store.get(runId)).seq
  const replay = await acceptTeamOutput({
    store,
    runId,
    output: accepted,
    hostVerdict,
    attemptId,
    outputs: { answer: 'verified' },
    task: { id: 'task-1', revision: 1, status: 'completed' },
    taskStatus: 'completed',
    artifact: { artifactId: 'artifact-1', digest: digest('artifact') }
  })
  assert.equal(replay.seq, seq)
  await assert.rejects(
    () =>
      acceptTeamOutput({
        store,
        runId,
        output: { ...accepted, unsupported: 'raw provider output' },
        task: { id: 'task-1', revision: 1, status: 'completed' },
        taskStatus: 'completed'
      }),
    TeamAcceptanceRejectedError
  )
})

test('W2 C-04 provisioning or contradictory member status cannot satisfy acceptance', async t => {
  const { store, runId, attemptId } = await fixture(t, [{ memberId: 'member-1', phase: 'active', status: 'provisioning' }], { attempt: true })
  await store.bindTeamTask(runId, { taskId: 'task-1', taskRevision: 1 })
  const accepted = {
    code: 'accepted',
    schemaVersion: 1,
    runId,
    stageId: 'stage-1',
    taskId: 'task-1',
    attemptId,
    sourceSessionId: 'lead',
    artifactId: 'artifact-1',
    digest: digest('artifact'),
    evidenceDigest: digest('evidence'),
    checks: ['schema', 'digest', 'artifact-digest', 'agreement']
  }
  const hostVerdict = {
    status: 'verified',
    artifactId: 'artifact-1',
    digest: digest('artifact'),
    byteLength: 8,
    schemaDigest: digest('schema'),
    evidenceDigest: digest('evidence'),
    runId,
    stageId: 'stage-1',
    taskId: 'task-1',
    attemptId,
    producerSessionId: 'lead',
    producerMemberId: 'member-1'
  }
  await assert.rejects(
    () =>
      acceptTeamOutput({
        store,
        runId,
        output: accepted,
        hostVerdict,
        attemptId,
        outputs: { answer: 'verified' },
        task: { id: 'task-1', revision: 1, status: 'completed' }
      }),
    error => error.issueCode === 'required-member-policy-unsatisfied'
  )
})

test('W2 C-04 canonical success requires accepted output and rejected output has an issue code', async t => {
  const { store, runId } = await fixture(t)
  await store.bindTeamTask(runId, { taskId: 'task-1', taskRevision: 1 })
  const base = {
    schemaVersion: 1,
    runId,
    stageId: 'stage-1',
    taskId: 'task-1',
    sourceSessionId: 'lead',
    artifactId: 'artifact-1',
    digest: digest('artifact'),
    evidenceDigest: digest('evidence'),
    checks: ['schema']
  }
  assert.equal(teamOutputAcceptanceSchema.safeParse({ ...base, code: 'rejected' }).success, false)
  await assert.rejects(
    () => store.updateTeamStage(runId, { state: 'succeeded' }),
    error => error.code === 'TEAM_STAGE_CONFLICT'
  )
  await assert.rejects(
    () => store.recordTeamOutputAcceptance(runId, { ...base, code: 'rejected' }),
    error => error.code === 'TEAM_OUTPUT_REJECTED'
  )
})

test('W2 C-03 canonical member identities are unique at the persistence boundary', async t => {
  const { store, runId } = await fixture(t)
  await assert.rejects(
    () =>
      store.updateTeamStage(runId, {
        members: [
          { memberId: 'member-1', name: 'worker-one', sessionId: 'session-1', phase: 'active', status: 'running' },
          { memberId: 'member-2', name: 'worker-one', sessionId: 'session-2', phase: 'active', status: 'running' }
        ]
      }),
    error => error.code === 'DURABILITY_FAILED'
  )
  const stage = (await store.get(runId)).teamStage
  assert.deepEqual(stage.members, [])
  assert.equal(
    teamStageRecordSchema.safeParse({
      ...stage,
      members: [
        { memberId: 'member-1', name: 'worker-one', sessionId: 'session-1', phase: 'active', status: 'running' },
        { memberId: 'member-2', name: 'worker-one', sessionId: 'session-2', phase: 'active', status: 'running' }
      ]
    }).success,
    false
  )
})

test('W2 C-05 late task binding cannot reactivate a cancelled stage', async t => {
  const { store, runId } = await fixture(t)
  await store.updateTeamStage(runId, { state: 'cancelled' })
  await assert.rejects(
    () => store.bindTeamTask(runId, { taskId: 'late-task', taskRevision: 1 }),
    error => error.code === 'TEAM_TASK_CONFLICT'
  )
  assert.equal((await store.get(runId)).teamStage.state, 'cancelled')
})

test('W2 C-03 member lifecycle preserves provisioning and failed states', () => {
  assert.equal(memberSnapshot({ id: 'member-1', name: 'worker', status: 'provisioning' }).phase, 'provisioning')
  assert.equal(memberSnapshot({ id: 'member-2', name: 'failed-worker', status: 'failed' }).phase, 'failed')
  assert.equal(memberSnapshot({ id: 'member-3', name: 'idle-worker', status: 'inactive' }).phase, 'inactive')
  assert.equal(memberSnapshot({ id: 'member-4', name: 'contradictory-worker', phase: 'active', status: 'failed' }).phase, 'failed')
})

test('W2 C-03 Team projection preserves the canonical member name for read-only UI', () => {
  const projected = projectTeamStage({
    runId: 'run-projection',
    definitionRevision: 'rev-1',
    definitionJson: '{}',
    inputRef: '{}',
    commandKey: 'scope--request',
    state: 'queued',
    attempts: [],
    log: [],
    seq: 0,
    createdAt: 1,
    updatedAt: 1,
    teamStage: {
      schemaVersion: 1,
      stageId: 'stage-1',
      runId: 'run-projection',
      teamId: 'team-1',
      leadSessionId: 'lead',
      taskSpecificationFingerprint: digest('spec'),
      state: 'active',
      members: [{ memberId: 'member-1', name: 'worker-one', phase: 'active', status: 'running', sessionId: 'member-1' }],
      updatedAt: 1
    }
  })
  assert.equal(projected?.members[0]?.name, 'worker-one')
})

test('W2 C-03 member spawn records native identity and failed lifecycle canonically', async t => {
  const { store, runId } = await fixture(t)
  let spawns = 0
  const member = await spawnBoundTeamMember({
    store,
    runId,
    adapter: {
      spawnTeammate: async (_lead, request) => {
        spawns++
        return { member: { id: 'member-1', name: request.name, status: 'running' } }
      }
    },
    lead: { agent: { id: 'lead' }, teamId: 'team-1', service: {} },
    request: { name: 'worker-one', description: 'worker', prompt: [], context: 'fresh', provider: 'deepseek', signal: new AbortController().signal },
    effectId: 'spawn-1'
  })
  assert.deepEqual(member, { memberId: 'member-1', name: 'worker-one', phase: 'active', status: 'running', sessionId: 'member-1' })
  assert.equal((await store.get(runId)).teamStage.members[0].memberId, 'member-1')
  await spawnBoundTeamMember({
    store,
    runId,
    adapter: {
      spawnTeammate: async () => {
        throw new Error('duplicate spawn')
      }
    },
    lead: { agent: { id: 'lead' }, teamId: 'team-1', service: {} },
    request: { name: 'worker-one', description: 'worker', prompt: [], context: 'fresh', provider: 'deepseek', signal: new AbortController().signal },
    effectId: 'spawn-2'
  })
  assert.equal(spawns, 1)
})

test('W2 C-03 concurrent same-name member spawns reserve one native effect', async t => {
  const { store, runId } = await fixture(t)
  let spawns = 0
  let release
  let resolveStarted
  const started = new Promise(resolve => {
    resolveStarted = resolve
  })
  const gate = new Promise(resolve => {
    release = resolve
  })
  const request = { name: 'worker-one', description: 'worker', prompt: [], context: 'fresh', provider: 'deepseek', signal: new AbortController().signal }
  const spawn = async (_lead, value) => {
    spawns++
    resolveStarted()
    await gate
    return { member: { id: 'member-1', name: value.name, status: 'running' } }
  }
  const first = spawnBoundTeamMember({
    store,
    runId,
    adapter: { spawnTeammate: spawn },
    lead: { agent: { id: 'lead' }, teamId: 'team-1', service: {} },
    request,
    effectId: 'spawn-a'
  })
  await started
  await assert.rejects(
    () =>
      spawnBoundTeamMember({
        store,
        runId,
        adapter: {
          spawnTeammate: async () => {
            throw new Error('duplicate spawn')
          }
        },
        lead: { agent: { id: 'lead' }, teamId: 'team-1', service: {} },
        request,
        effectId: 'spawn-b'
      }),
    error => error.code === 'TEAM_EFFECT_UNKNOWN'
  )
  release()
  await first
  assert.equal(spawns, 1)
  assert.deepEqual(
    (await store.get(runId)).teamStage.members.map(member => member.name),
    ['worker-one']
  )
})

test('W2 C-03 settled spawn remains reserved until canonical member binding', async t => {
  const { store, runId } = await fixture(t)
  let spawns = 0
  let releaseBinding
  let resolveBindingStarted
  const bindingStarted = new Promise(resolve => {
    resolveBindingStarted = resolve
  })
  const bindingGate = new Promise(resolve => {
    releaseBinding = resolve
  })
  const originalUpsert = store.upsertTeamMember.bind(store)
  t.mock.method(store, 'upsertTeamMember', async (id, member) => {
    resolveBindingStarted()
    await bindingGate
    return await originalUpsert(id, member)
  })
  const request = { name: 'worker-one', description: 'worker', prompt: [], context: 'fresh', provider: 'deepseek', signal: new AbortController().signal }
  const first = spawnBoundTeamMember({
    store,
    runId,
    adapter: {
      spawnTeammate: async (_lead, value) => {
        spawns++
        return { member: { id: 'member-1', name: value.name, status: 'running' } }
      }
    },
    lead: { agent: { id: 'lead' }, teamId: 'team-1', service: {} },
    request,
    effectId: 'spawn-a'
  })
  await bindingStarted
  await assert.rejects(
    () =>
      spawnBoundTeamMember({
        store,
        runId,
        adapter: {
          spawnTeammate: async () => {
            throw new Error('duplicate spawn')
          }
        },
        lead: { agent: { id: 'lead' }, teamId: 'team-1', service: {} },
        request,
        effectId: 'spawn-b'
      }),
    error => error.code === 'TEAM_EFFECT_UNKNOWN'
  )
  releaseBinding()
  await first
  assert.equal(spawns, 1)
})

test('W2 C-03 malformed native member response becomes recovery_required', async t => {
  const { store, runId } = await fixture(t)
  await assert.rejects(
    () =>
      spawnBoundTeamMember({
        store,
        runId,
        adapter: { spawnTeammate: async () => null },
        lead: { agent: { id: 'lead' }, teamId: 'team-1', service: {} },
        request: { name: 'worker-one', description: 'worker', prompt: [], context: 'fresh', provider: 'deepseek', signal: new AbortController().signal },
        effectId: 'spawn-malformed'
      }),
    error => error.code === 'TEAM_MEMBER_INVALID'
  )
  const record = await store.get(runId)
  assert.equal(record.teamStage.state, 'recovery_required')
  assert.equal(record.teamStage.effects.find(effect => effect.effectId === 'spawn-malformed')?.state, 'recovery_required')
})

test('W2 C-04 native success with an unpersistable result becomes recovery_required', async t => {
  const { store, runId } = await fixture(t)
  const runner = new TeamStageRunner(store)
  await assert.rejects(
    () =>
      runner.dispatch({
        store,
        runId,
        stageId: 'stage-1',
        teamId: 'team-1',
        effectId: 'result-map-failure',
        kind: 'spawn',
        memberName: 'worker-one',
        actorSessionId: 'lead',
        effect: async () => ({ id: 'native-1' }),
        result: () => {
          throw new Error('result mapping failed')
        }
      }),
    error => error.message === 'result mapping failed'
  )
  const record = await store.get(runId)
  assert.equal(record.teamStage.state, 'recovery_required')
  assert.equal(record.teamStage.effects.find(effect => effect.effectId === 'result-map-failure')?.state, 'recovery_required')
})

test('W2 C-04 result persistence failure after native success becomes recovery_required', async t => {
  const { store, runId } = await fixture(t)
  const runner = new TeamStageRunner(store)
  const originalTransition = store.transition.bind(store)
  let transitions = 0
  t.mock.method(store, 'transition', async (id, reducer) => {
    transitions++
    if (transitions === 2) throw new DurabilityFailureError('team-result', new Error('injected storage failure'))
    return await originalTransition(id, reducer)
  })
  let effects = 0
  await assert.rejects(
    () =>
      runner.dispatch({
        store,
        runId,
        stageId: 'stage-1',
        teamId: 'team-1',
        effectId: 'result-write-failure',
        kind: 'spawn',
        memberName: 'worker-one',
        actorSessionId: 'lead',
        effect: async () => {
          effects++
          return { id: 'native-1' }
        }
      }),
    error => error.code === 'DURABILITY_FAILED'
  )
  assert.equal(effects, 1)
  const record = await store.get(runId)
  assert.equal(record.teamStage.state, 'recovery_required')
  assert.equal(record.teamStage.effects.find(effect => effect.effectId === 'result-write-failure')?.state, 'recovery_required')
})

test('W2 C-04 canonical effects reject destructive replacement', async t => {
  const { store, runId } = await fixture(t)
  const runner = new TeamStageRunner(store)
  await runner.dispatch({
    store,
    runId,
    stageId: 'stage-1',
    teamId: 'team-1',
    effectId: 'canonical-effect',
    kind: 'observe',
    actorSessionId: 'lead',
    effect: async () => 'ok'
  })
  await assert.rejects(
    () => store.updateTeamStage(runId, { effects: [] }),
    error => error.code === 'TEAM_STAGE_CONFLICT'
  )
  assert.equal(
    (await store.get(runId)).teamStage.effects.some(effect => effect.effectId === 'canonical-effect'),
    true
  )
})

test('W2 C-03/C-04 canonical effect facts survive audit-log truncation', async t => {
  const { store, runId } = await fixture(t)
  const runner = new TeamStageRunner(store)
  await runner.dispatch({
    store,
    runId,
    stageId: 'stage-1',
    teamId: 'team-1',
    effectId: 'settled-result',
    kind: 'update',
    taskId: 'task-1',
    actorSessionId: 'lead',
    effect: async () => 'native-result',
    result: () => ({ ok: true, taskId: 'task-result', taskRevision: 2, memberId: 'member-result', status: 'completed' })
  })
  for (let index = 0; index < 220; index++) {
    const facts = { runId, stageId: 'stage-1', teamId: 'team-1', effectId: `settled-${index}`, kind: 'observe', actorSessionId: 'lead' }
    await runner.dispatch({ ...facts, effect: async () => index, result: () => ({ ok: true }) })
  }
  const pending = { runId, stageId: 'stage-1', teamId: 'team-1', effectId: 'pending-1', kind: 'spawn', memberName: 'pending-worker', actorSessionId: 'lead' }
  await recordTeamEffectIntent(store, pending)
  let dispatched = false
  await assert.rejects(
    () =>
      runner.dispatch({
        ...pending,
        effect: async () => {
          dispatched = true
          return null
        }
      }),
    error => error.code === 'TEAM_EFFECT_UNKNOWN'
  )
  assert.equal(dispatched, false)
  const record = await store.get(runId)
  assert.equal(
    record.teamStage.effects.some(effect => effect.effectId === 'pending-1' && effect.state === 'pending'),
    true
  )
  assert.deepEqual(
    record.teamStage.effects.find(effect => effect.effectId === 'settled-result'),
    {
      effectId: 'settled-result',
      kind: 'update',
      stageId: 'stage-1',
      teamId: 'team-1',
      actorSessionId: 'lead',
      taskId: 'task-1',
      state: 'succeeded',
      intentAt: record.teamStage.effects.find(effect => effect.effectId === 'settled-result').intentAt,
      settledAt: record.teamStage.effects.find(effect => effect.effectId === 'settled-result').settledAt,
      ok: true,
      resultTaskId: 'task-result',
      resultTaskRevision: 2,
      resultMemberId: 'member-result',
      resultStatus: 'completed'
    }
  )
})
