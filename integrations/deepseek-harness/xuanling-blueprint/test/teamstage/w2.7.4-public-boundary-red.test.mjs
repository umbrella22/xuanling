import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BlueprintService } from '../../src/index.ts'
import { decodeDefinition, validateDefinition } from '../../src/definition/index.ts'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'

const digest = value => createHash('sha256').update(value).digest('hex')
let fixtureNumber = 0

const team = {
  task: { subject: 'Review frozen output', description: 'Review the frozen output and report the structured result.' },
  members: [{ name: 'worker-one', description: 'Review the output.', agentRef: 'worker', context: 'fresh' }],
  requiredChecks: ['schema'],
}

function definition(kind = 'agentTask') {
  return {
    schemaVersion: 1,
    id: 'public-team-boundary',
    name: 'Public Team boundary',
    resources: {
      worker: { kind: 'agent', path: 'lib/agents/worker.md' },
      resultSchema: { kind: 'schema', path: 'lib/schemas/result.json' },
    },
    graph: {
      nodes: [{ id: 'work', kind, agentRef: 'worker', outputSchemaRef: 'resultSchema', outputs: { result: 'json' }, ...(kind === 'agentTask' ? { teamStage: structuredClone(team) } : {}) }],
      edges: [],
    },
  }
}

function makeHarness() {
  const lead = { id: 'lead-session', session: { id: 'lead-session', header: { origin: 'root' } } }
  const agents = new Map([[lead.id, lead]])
  let creates = 0
  const tasks = new Map()
  const service = {
    membership(agent) { return { root: agent, id: 'team-1', role: 'lead', name: 'lead' } },
    listMembers() { return [] },
    spawnTeammate() { return Promise.resolve({}) },
    sendMessage() { return Promise.resolve({}) },
    createTask(_agent, request) {
      creates += 1
      const task = { id: `task-${creates}`, revision: 1, status: 'pending', subject: request.subject }
      tasks.set(task.id, task)
      return Promise.resolve(task)
    },
    getTask(_agent, id) { return structuredClone(tasks.get(id)) },
    listTasks() { return [...tasks.values()].map(task => structuredClone(task)) },
    updateTask(_agent, request) { return Promise.resolve({ id: request.taskId, revision: request.expectedRevision + 1, status: 'deleted' }) },
    waitForChange() { return Promise.resolve({ timedOut: true }) },
    interrupt() { return { previousStatus: 'inactive' } },
  }
  return {
    lead,
    service,
    get creates() { return creates },
    ctx: { get: key => key === 'agents' ? { get: id => agents.get(id) } : key === 'agentTeams' ? service : undefined },
  }
}

async function fixture(t, { kind = 'agentTask', sourceSessionId = 'lead-session', attemptState = 'running' } = {}) {
  const harness = makeHarness()
  const root = await mkdtemp(join(tmpdir(), `xuanling-w274-${fixtureNumber++}-`))
  const opened = await openBlueprintDomain({ backend: 'json', path: join(root, 'store') })
  const store = new RunStore(opened.domain)
  const frozen = definition(kind)
  const { runId } = await store.createRun({ scope: 'run', requestId: `run-${fixtureNumber}`, payloadFingerprint: digest(`run-${fixtureNumber}`) }, 'semantic-1', JSON.stringify(frozen), '{}', { source: { sessionId: sourceSessionId, kind: 'ui' } })
  const attempt = await store.recordIntent(runId, { nodeId: 'work', kind, resourceDigests: { worker: 'a'.repeat(64), resultSchema: 'b'.repeat(64) } })
  if (attemptState !== 'running') {
    await store.recordResult(runId, attempt.attemptId, { ok: attemptState === 'succeeded', outcome: { kind: attemptState }, evidence: 'fixture' })
  }
  const service = Object.create(BlueprintService.prototype)
  service.ctx = harness.ctx
  service.checkArgs = () => {}
  service.decodeOrThrow = definitionJson => {
    const parsed = decodeDefinition(definitionJson)
    validateDefinition(parsed)
    return parsed
  }
  service.configuredRuntime = async () => ({ store, controllers: new Map(), cancellationTails: new Map() })
  t.after(async () => { await opened.close(); await rm(root, { recursive: true, force: true }) })
  return { service, store, runId, attempt, harness, frozen }
}

function request(runId, overrides = {}) {
  return {
    sessionId: 'lead-session',
    runId,
    stageId: 'work',
    taskSpecificationFingerprint: digest(JSON.stringify({ config: team, resources: { worker: 'a'.repeat(64), resultSchema: 'b'.repeat(64) } })),
    subject: team.task.subject,
    description: team.task.description,
    ...overrides,
  }
}

async function rejectedWithoutEffect(service, store, runId, args) {
  const before = await store.get(runId)
  await assert.rejects(() => service.startTeamStage(args), error => error.code === 'blueprint/team-stage-conflict')
  assert.deepEqual(await store.get(runId), before, 'public verifier rejection must be durable/native side-effect free')
}

test('W2.7.4 red: humanDecision stage cannot be addressed as a TeamStage', async t => {
  const h = await fixture(t, { kind: 'humanDecision' })
  await rejectedWithoutEffect(h.service, h.store, h.runId, request(h.runId))
  assert.equal(h.harness.creates, 0)
})

test('W2.7.4 red: foreign stage id is rejected before Team task creation', async t => {
  const h = await fixture(t)
  await rejectedWithoutEffect(h.service, h.store, h.runId, request(h.runId, { stageId: 'foreign-stage' }))
  assert.equal(h.harness.creates, 0)
})

test('W2.7.4 red: a source session that is not the frozen Run source is rejected', async t => {
  const h = await fixture(t, { sourceSessionId: 'another-root' })
  await rejectedWithoutEffect(h.service, h.store, h.runId, request(h.runId))
  assert.equal(h.harness.creates, 0)
})

test('W2.7.4 red: a settled or non-ready Attempt cannot open a public TeamStage sidecar', async t => {
  const h = await fixture(t, { attemptState: 'succeeded' })
  await rejectedWithoutEffect(h.service, h.store, h.runId, request(h.runId))
  assert.equal(h.harness.creates, 0)
})

test('W2.7.4 red: matching-format but wrong task fingerprint/text cannot override frozen Team config', async t => {
  const h = await fixture(t)
  await rejectedWithoutEffect(h.service, h.store, h.runId, request(h.runId, {
    taskSpecificationFingerprint: digest('same-format-but-foreign'),
    subject: 'Forged task',
    description: 'Forged description',
  }))
  assert.equal(h.harness.creates, 0)
})

test('W2.7.4 green contract: a legal frozen TeamStage request binds the original Attempt and replays once', async t => {
  const h = await fixture(t)
  const first = await h.service.startTeamStage(request(h.runId))
  assert.equal(first.team.stageId, 'work')
  assert.equal(first.team.attemptId, h.attempt.attemptId)
  assert.deepEqual(first.team.requiredChecks, team.requiredChecks)
  assert.equal(first.task.id, 'task-1')
  const replay = await h.service.startTeamStage(request(h.runId))
  assert.equal(replay.replayed, true)
  assert.equal(replay.task.id, first.task.id)
  assert.equal(h.harness.creates, 1)
})

test('W2.7.4 red: settleTerminal cannot settle a Run with an active provisioning TeamStage Attempt', async t => {
  const h = await fixture(t)
  const bound = await h.store.bindTeamStage(h.runId, {
    stageId: 'work',
    teamId: 'team-1',
    leadSessionId: 'lead-session',
    taskSpecificationFingerprint: request(h.runId).taskSpecificationFingerprint,
    attemptId: h.attempt.attemptId,
    requiredChecks: [...team.requiredChecks],
  })
  assert.equal(bound.teamStage.state, 'provisioning')

  await assert.rejects(
    () => h.store.settleTerminal(h.runId, 'succeeded'),
    error => error.code === 'TEAM_STAGE_CONFLICT',
  )

  const after = await h.store.get(h.runId)
  assert.equal(after.state, 'running')
  assert.equal(after.teamStage.state, 'provisioning')
  const attempt = after.attempts.find(value => value.attemptId === h.attempt.attemptId)
  assert.ok(attempt)
  assert.equal(attempt.state, 'running')
  assert.equal(attempt.result, undefined)
})

test('W2.7.4 red: recordResult cannot settle an Attempt after TeamStage provisioning bind', async t => {
  const h = await fixture(t)
  const bound = Promise.withResolvers()
  const releaseBind = Promise.withResolvers()
  const enteredResult = Promise.withResolvers()
  const originalBind = h.store.bindTeamStage.bind(h.store)
  t.mock.method(h.store, 'bindTeamStage', async (...args) => {
    const record = await originalBind(...args)
    bound.resolve(record)
    await releaseBind.promise
    return record
  })
  const originalRecordResult = h.store.recordResult.bind(h.store)
  t.mock.method(h.store, 'recordResult', async (...args) => {
    enteredResult.resolve()
    return await originalRecordResult(...args)
  })
  t.after(() => releaseBind.resolve())

  const started = h.service.startTeamStage(request(h.runId))
  const boundRecord = await bound.promise
  assert.equal(boundRecord.teamStage.state, 'provisioning')
  assert.equal(boundRecord.attempts[0].state, 'running')

  const settling = h.store.recordResult(h.runId, h.attempt.attemptId, {
    ok: true,
    outcome: { kind: 'succeeded' },
    evidence: 'concurrent-settlement',
  })
  await enteredResult.promise
  releaseBind.resolve()

  const [, conflict] = await Promise.all([
    started,
    assert.rejects(settling, error => error.code === 'TEAM_STAGE_CONFLICT'),
  ])
  assert.equal(conflict, undefined)

  const action = await started
  assert.equal(action.task.id, 'task-1')
  assert.equal(h.harness.creates, 1)
  const after = await h.store.get(h.runId)
  const attempt = after.attempts.find(value => value.attemptId === h.attempt.attemptId)
  assert.ok(attempt)
  assert.equal(attempt.state, 'running')
  assert.equal(attempt.result, undefined)
})

test('W2.7.4 red: a bound TeamStage cannot replay after its original Attempt leaves the active set', async t => {
  const h = await fixture(t)
  const first = await h.service.startTeamStage(request(h.runId))
  await h.store.transition(h.runId, draft => {
    const attempt = draft.attempts.find(value => value.attemptId === h.attempt.attemptId)
    assert.ok(attempt)
    attempt.state = 'recovery_required'
  })
  const before = await h.store.get(h.runId)
  await assert.rejects(
    () => h.service.startTeamStage(request(h.runId)),
    error => error.code === 'blueprint/team-stage-conflict',
  )
  assert.deepEqual(await h.store.get(h.runId), before, 'bound replay rejection is side-effect free')
  assert.equal(h.harness.creates, 1)
  assert.equal(first.team.attemptId, h.attempt.attemptId)
})
