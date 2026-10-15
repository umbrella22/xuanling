import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { runRecordSchema, teamStageRecordSchema, teamOutputAcceptanceSchema } from '../../src/persistence/records.ts'
import { createBackup, openBlueprintDomain, restoreBackup, RunStore } from '../../src/persistence/index.ts'
import { inspectSessionCodec } from '../../src/conversation/contracts.ts'
import { mapTeamStageError } from '../../src/conversation/host-tools.ts'
import { mapTeamStageRemoteError } from '../../src/typert.remote.ts'

const record = () => ({
  runId: 'run-teamstage',
  definitionRevision: 'rev-1',
  definitionJson: '{}',
  inputRef: 'input',
  commandKey: 'start:request',
  state: 'queued',
  attempts: [],
  log: [],
  seq: 0,
  createdAt: 1,
  updatedAt: 1
})

test('W1 RED C-02/C-06: RunRecord accepts an additive TeamStage aggregate', () => {
  const parsed = runRecordSchema.safeParse({
    ...record(),
    teamStage: {
      stageId: 'stage-1',
      runId: 'run-teamstage',
      teamId: 'team-1',
      leadSessionId: 'session-lead',
      schemaVersion: 1,
      taskSpecificationFingerprint: 'a'.repeat(64),
      taskId: 'task-1',
      taskRevision: 1,
      state: 'provisioning',
      members: [],
      updatedAt: 1
    }
  })
  assert.equal(parsed.success, true, 'W1 requires the additive TeamStage field to survive the record codec')
  assert.ok(parsed.success && parsed.data.teamStage, 'current codec silently drops the TeamStage aggregate')
})

test('W1 RED C-04/C-08: inspect DTO carries a strict TeamStage projection', () => {
  const parsed = inspectSessionCodec().safeParse({
    status: 'bound',
    sessionId: 'session-lead',
    runs: [],
    selected: {
      run: { runId: 'run-teamstage', state: 'queued', definitionRevision: 'rev-1', seq: 0, attempts: [], logTail: [] },
      graph: { nodes: [], edges: [] },
      focusAttemptIds: [],
      team: {
        schemaVersion: 1,
        stageId: 'stage-1',
        runId: 'run-teamstage',
        teamId: 'team-1',
        leadSessionId: 'session-lead',
        taskSpecificationFingerprint: 'a'.repeat(64),
        taskId: 'task-1',
        taskRevision: 1,
        state: 'provisioning',
        members: [],
        updatedAt: 1,
        outputAcceptance: {
          code: 'accepted',
          schemaVersion: 1,
          runId: 'run-teamstage',
          stageId: 'stage-1',
          taskId: 'task-1',
          sourceSessionId: 'session-lead',
          artifactId: 'artifact-1',
          digest: 'b'.repeat(64),
          evidenceDigest: 'b'.repeat(64),
          checks: ['schema']
        }
      }
    }
  })
  assert.equal(parsed.success, true, 'W1 requires a strict TeamStage projection in the host DTO')
  const unknown = inspectSessionCodec().safeParse({
    status: 'bound',
    sessionId: 'session-lead',
    runs: [],
    selected: {
      run: { runId: 'run-teamstage', state: 'queued', definitionRevision: 'rev-1', seq: 0, attempts: [], logTail: [] },
      graph: { nodes: [], edges: [] },
      focusAttemptIds: [],
      team: {
        stageId: 'stage-1',
        runId: 'run-teamstage',
        teamId: 'team-1',
        leadSessionId: 'session-lead',
        taskSpecificationFingerprint: 'a'.repeat(64),
        state: 'provisioning',
        members: [],
        updatedAt: 1,
        unsupported: true
      }
    }
  })
  assert.equal(unknown.success, false, 'unknown TeamStage DTO fields must fail closed')
})

test('W1 RED C-02: RunStore exposes atomic TeamStage binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xuanling-teamstage-red-'))
  let opened
  try {
    opened = await openBlueprintDomain({ backend: 'json', path: join(root, 'store') })
    const store = new RunStore(opened.domain)
    assert.equal(typeof store.bindTeamStage, 'function', 'binding must be a RunStore single-record RMW operation')
  } finally {
    await opened?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('W1 GREEN CONTROL C-09: ordinary legacy RunRecord remains readable', () => {
  assert.equal(runRecordSchema.safeParse(record()).success, true)
})

const digest = value => createHash('sha256').update(value).digest('hex')
const admit = (store, id) => store.createRun({ scope: 'run', requestId: id, payloadFingerprint: digest(id) }, 'rev-1', '{}', '{}')

for (const backend of ['json', 'sqlite']) {
  test(`W1 C-02/C-06 ${backend}: binding is durable, idempotent, and legacy reads survive reopen`, async t => {
    const root = await mkdtemp(join(tmpdir(), `xuanling-teamstage-${backend}-`))
    const runtimeRoot = join(root, 'runtime')
    await mkdir(join(runtimeRoot, 'store'), { recursive: true })
    const path = backend === 'json' ? join(runtimeRoot, 'store') : join(runtimeRoot, 'store', 'runs.sqlite')
    let opened = await openBlueprintDomain({ backend, path })
    let store = new RunStore(opened.domain)
    const { runId } = await admit(store, 'team-binding')
    const binding = { stageId: 'stage-1', teamId: 'team-1', leadSessionId: 'lead-session', taskSpecificationFingerprint: digest('task-spec') }
    const bound = await store.bindTeamStage(runId, binding)
    assert.equal(bound.teamStage.state, 'provisioning')
    const replay = await store.bindTeamStage(runId, binding)
    assert.deepEqual(replay, bound, 'same binding replay must not advance the canonical record')
    await assert.rejects(
      () => store.bindTeamStage(runId, { ...binding, teamId: 'foreign-team' }),
      error => error.code === 'TEAM_STAGE_CONFLICT'
    )
    const tasked = await store.bindTeamTask(runId, { taskId: 'task-1', taskRevision: 1 })
    assert.equal(tasked.teamStage.taskId, 'task-1')
    const taskReplay = await store.bindTeamTask(runId, { taskId: 'task-1', taskRevision: 1 })
    assert.deepEqual(taskReplay, tasked, 'same task binding replay must return the original canonical record')
    await assert.rejects(
      () => store.bindTeamTask(runId, { taskId: 'foreign-task', taskRevision: 1 }),
      error => error.code === 'TEAM_TASK_CONFLICT'
    )
    const accepted = {
      code: 'accepted',
      schemaVersion: 1,
      runId,
      stageId: 'stage-1',
      taskId: 'task-1',
      sourceSessionId: 'member-session',
      artifactId: 'artifact-1',
      digest: digest('artifact'),
      evidenceDigest: digest('evidence'),
      checks: ['schema', 'digest']
    }
    const settled = await store.recordTeamOutputAcceptance(runId, accepted)
    assert.equal(settled.teamStage.outputAcceptance.code, 'accepted')
    const acceptanceReplay = await store.recordTeamOutputAcceptance(runId, accepted)
    assert.deepEqual(acceptanceReplay, settled, 'same output acceptance replay must return the original canonical record')
    await assert.rejects(
      () => store.recordTeamOutputAcceptance(runId, { ...accepted, artifactId: 'different-artifact' }),
      error => error.code === 'TEAM_OUTPUT_REJECTED'
    )
    await assert.rejects(
      () => store.recordTeamOutputAcceptance(runId, { ...accepted, taskId: 'foreign-task' }),
      error => error.code === 'TEAM_OUTPUT_REJECTED'
    )
    await opened.close()
    opened = undefined
    opened = await openBlueprintDomain({ backend, path })
    store = new RunStore(opened.domain)
    assert.equal((await store.get(runId)).teamStage.outputAcceptance.evidenceDigest, accepted.evidenceDigest)
    const legacyId = 'legacy-run'
    await opened.domain.table('runs').put(legacyId, record())
    assert.equal(Object.hasOwn(await store.get(legacyId), 'teamStage'), false)
    await opened.close()
    opened = undefined
    const backup = createBackup(runtimeRoot)
    const restoredRoot = join(root, 'restored')
    restoreBackup(backup.archive, restoredRoot)
    const restoredPath = backend === 'json' ? join(restoredRoot, 'store') : join(restoredRoot, 'store', 'runs.sqlite')
    opened = await openBlueprintDomain({ backend, path: restoredPath })
    store = new RunStore(opened.domain)
    assert.deepEqual(await store.get(runId), settled, 'TeamStage fields must survive backup/restore byte-for-byte')
    assert.equal(Object.hasOwn(await store.get(legacyId), 'teamStage'), false)
    t.after(async () => {
      await opened?.close()
      await rm(root, { recursive: true, force: true })
    })
  })
}

test('W1 C-04 strict TeamStageRecord rejects foreign or malformed acceptance', () => {
  const valid = {
    schemaVersion: 1,
    stageId: 'stage-1',
    runId: 'run-1',
    teamId: 'team-1',
    leadSessionId: 'lead',
    taskSpecificationFingerprint: digest('spec'),
    state: 'provisioning',
    members: [],
    updatedAt: 1
  }
  assert.equal(teamStageRecordSchema.safeParse(valid).success, true)
  assert.equal(teamStageRecordSchema.safeParse({ ...valid, schemaVersion: 2 }).success, false)
  assert.equal(teamStageRecordSchema.safeParse({ ...valid, taskId: 'task-only' }).success, false)
  assert.equal(teamStageRecordSchema.safeParse({ ...valid, unsupported: true }).success, false)
  assert.equal(
    teamOutputAcceptanceSchema.safeParse({
      code: 'accepted',
      schemaVersion: 1,
      runId: 'run-1',
      stageId: 'stage-1',
      taskId: 'task-1',
      sourceSessionId: 'member',
      artifactId: 'artifact',
      digest: digest('artifact'),
      evidenceDigest: digest('evidence'),
      checks: []
    }).success,
    false
  )
  const accepted = {
    code: 'accepted',
    schemaVersion: 1,
    runId: 'run-1',
    stageId: 'stage-1',
    taskId: 'task-1',
    sourceSessionId: 'member',
    artifactId: 'artifact',
    digest: digest('artifact'),
    evidenceDigest: digest('evidence'),
    checks: ['schema']
  }
  assert.equal(
    teamStageRecordSchema.safeParse({ ...valid, taskId: 'task-1', taskRevision: 1, outputAcceptance: { ...accepted, taskId: 'foreign-task' } }).success,
    false
  )
  assert.equal(runRecordSchema.safeParse({ ...record(), teamStage: { ...valid, runId: 'foreign-run' } }).success, false)
})

test('W1 C-08 host/remote errors map to stable redacted TeamStage codes', () => {
  assert.equal(mapTeamStageError({ code: 'TEAM_TASK_CONFLICT' }), 'blueprint/team-task-conflict')
  assert.equal(mapTeamStageError({ code: 'DURABILITY_FAILED' }), 'blueprint/durability-failed')
  assert.equal(mapTeamStageRemoteError({ code: 'blueprint/team-output-rejected' }), 'blueprint/team-output-rejected')
  assert.equal(mapTeamStageRemoteError({ code: 'blueprint/private-provider-body' }), 'blueprint/remote-failed')
  assert.equal(mapTeamStageRemoteError({ message: 'PRIVATE_PROVIDER_BODY' }), 'blueprint/remote-failed')
})
