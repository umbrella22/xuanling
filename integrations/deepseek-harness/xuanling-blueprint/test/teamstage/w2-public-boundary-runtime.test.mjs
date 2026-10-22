import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BlueprintService } from '../../src/index.ts'
import { decodeDefinition, validateDefinition } from '../../src/definition/index.ts'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'
import { frozenTeamTaskSpecificationFingerprint } from '../../src/teamstage/public-boundary.ts'

const digest = value => createHash('sha256').update(value).digest('hex')
let fixtureNumber = 0

const teamStage = {
  task: { subject: 'Review frozen output', description: 'Review the frozen output and report the structured result.' },
  members: [{ name: 'worker-one', description: 'Review the output.', agentRef: 'worker', context: 'fresh' }],
  requiredChecks: ['schema']
}
const teamDefinition = {
  schemaVersion: 2,
  id: 'public-team-runtime',
  name: 'Public Team runtime',
  resources: { worker: { kind: 'agent', path: 'lib/agents/worker.md' }, resultSchema: { kind: 'schema', path: 'lib/schemas/result.json' } },
  graph: {
    nodes: [{ id: 'stage-1', kind: 'agentTask', agentRef: 'worker', outputSchemaRef: 'resultSchema', outputs: { result: 'json' }, teamStage }],
    edges: []
  }
}

function makeTeamHarness({ available = true } = {}) {
  const lead = { id: 'lead-session', session: { id: 'lead-session', header: { origin: 'root' } } }
  const agents = new Map([['lead-session', lead]])
  let creates = 0
  let interrupts = 0
  let reads = 0
  const tasks = new Map()
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
    createTask(_agent, request) {
      creates++
      const task = { id: `task-${creates}`, revision: 1, status: 'pending', subject: request.subject }
      tasks.set(task.id, task)
      return Promise.resolve(task)
    },
    getTask(_agent, id) {
      reads++
      const task = tasks.get(id)
      if (!task) throw new Error('task missing')
      return { ...task, status: 'completed' }
    },
    listTasks() {
      return [...tasks.values()]
    },
    updateTask(_agent, request) {
      const task = {
        id: request.taskId,
        revision: request.expectedRevision + 1,
        status: request.action === 'delete' ? 'deleted' : 'completed'
      }
      tasks.set(task.id, task)
      return Promise.resolve(task)
    },
    waitForChange() {
      return Promise.resolve({ timedOut: true })
    },
    interrupt() {
      interrupts++
      return { previousStatus: 'inactive' }
    }
  }
  const values = new Map([['agents', { get: id => agents.get(id) }]])
  if (available) values.set('agentTeams', service)
  const ctx = { get: key => values.get(key) }
  return {
    ctx,
    lead,
    service,
    get creates() {
      return creates
    },
    get reads() {
      return reads
    },
    get interrupts() {
      return interrupts
    },
    tasks
  }
}

async function fixture(t, harness = makeTeamHarness()) {
  const root = await mkdtemp(join(tmpdir(), `xuanling-w26-${fixtureNumber++}-`))
  const opened = await openBlueprintDomain({ path: join(root, 'store') })
  const store = new RunStore(opened.domain)
  const definitionJson = JSON.stringify(teamDefinition)
  const { runId } = await store.createRun(
    { scope: 'teamstage', requestId: `run-${fixtureNumber}`, payloadFingerprint: digest(`run-${fixtureNumber}`) },
    'rev-1',
    definitionJson,
    '{}',
    { source: { sessionId: 'lead-session', kind: 'ui' } }
  )
  await store.recordIntent(runId, { nodeId: 'stage-1', kind: 'agentTask', resourceDigests: { worker: 'a'.repeat(64), resultSchema: 'b'.repeat(64) } })
  const service = Object.create(BlueprintService.prototype)
  service.ctx = harness.ctx
  service.checkArgs = () => {}
  service.decodeOrThrow = text => {
    const parsed = decodeDefinition(text)
    validateDefinition(parsed)
    return parsed
  }
  service.configuredRuntime = async () => ({ store, controllers: new Map(), cancellationTails: new Map() })
  t.after(async () => {
    await opened.close()
    await rm(root, { recursive: true, force: true })
  })
  const stageArgs = run => ({
    sessionId: 'lead-session',
    runId: run,
    stageId: 'stage-1',
    taskSpecificationFingerprint: frozenTeamTaskSpecificationFingerprint(teamStage, { worker: 'a'.repeat(64), resultSchema: 'b'.repeat(64) }),
    subject: teamStage.task.subject,
    description: teamStage.task.description
  })
  return { service, store, runId, harness, stageArgs }
}

test('W2.6 C-01/C-02 public TeamStage mutation derives Team identity and replays task creation', async t => {
  const { service, store, runId, harness, stageArgs } = await fixture(t)
  const args = stageArgs(runId)
  const first = await service.startTeamStage(args)
  assert.equal(first.team.teamId, 'team-1')
  assert.equal(first.team.leadSessionId, 'lead-session')
  assert.equal(first.team.taskId, first.task.id)
  assert.equal(first.replayed, false)
  const replay = await service.startTeamStage(args)
  assert.equal(replay.replayed, true)
  assert.equal(replay.task.id, first.task.id)
  assert.equal(harness.creates, 1)
  assert.equal((await store.get(runId)).teamStage.teamId, 'team-1')
})

test('W2.6 C-08 missing Team capability fails before durable stage binding', async t => {
  const harness = makeTeamHarness({ available: false })
  const { service, store, runId, stageArgs } = await fixture(t, harness)
  await assert.rejects(
    () => service.startTeamStage(stageArgs(runId)),
    error => error.code === 'blueprint/team-unavailable'
  )
  assert.equal((await store.get(runId)).teamStage, undefined)
})

test('W2.6 C-05 public cancellation preserves the unrelated-member boundary', async t => {
  const { service, runId, harness, stageArgs } = await fixture(t)
  await service.startTeamStage(stageArgs(runId))
  const result = await service.cancelTeamStage({ sessionId: 'lead-session', runId, memberNames: [] })
  assert.equal(result.team.state, 'cancelled')
  assert.equal(harness.interrupts, 0)
})

test('W2.7.1 C-04 public acceptance rejects client-only artifact evidence', async t => {
  const { service, store, runId, stageArgs } = await fixture(t)
  const started = await service.startTeamStage(stageArgs(runId))
  await assert.rejects(
    () =>
      service.acceptTeamStageOutput({
        sessionId: 'lead-session',
        runId,
        stageId: 'stage-1',
        taskId: started.task.id,
        code: 'accepted',
        schemaVersion: 1,
        artifactId: 'artifact-1',
        digest: digest('artifact'),
        evidenceDigest: digest('evidence'),
        checks: ['schema']
      }),
    error => error.code === 'blueprint/team-output-rejected'
  )
  const record = await store.get(runId)
  assert.equal(record.teamStage.state, 'active')
  assert.equal(record.teamStage.outputAcceptance, undefined)
})

test('W2.6 C-04 rejected output records without reading native task state', async t => {
  const { service, runId, harness, stageArgs } = await fixture(t)
  await service.startTeamStage(stageArgs(runId))
  harness.service.getTask = () => {
    throw new Error('native task read must not gate a rejection')
  }
  const result = await service.acceptTeamStageOutput({
    sessionId: 'lead-session',
    runId,
    stageId: 'stage-1',
    taskId: 'task-1',
    code: 'rejected',
    schemaVersion: 1,
    artifactId: 'artifact-1',
    digest: digest('artifact'),
    evidenceDigest: digest('evidence'),
    checks: ['schema'],
    issueCode: 'schema-invalid'
  })
  assert.equal(result.team.state, 'failed')
  assert.equal(result.team.outputAcceptance.code, 'rejected')
  assert.equal(harness.reads, 0)
})
