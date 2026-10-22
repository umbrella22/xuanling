/** W1.3 runtime backstops. Real admission, restored driver, snapshots and JSON
 * store run against the existing scripted Agent factory; no provider is called. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'
import { RuntimeSnapshots } from '../../src/resources/runtime-snapshots.ts'
import { harness, definition, agentNode, agentResources, records, drain, sha256 } from '../runtime-contracts/agent-fixtures.mjs'

function teamDefinition() {
  return definition(
    [
      agentNode({
        outputSchemaRef: 'answerSchema',
        teamStage: {
          task: { subject: 'Review output', description: 'Review the structured output.' },
          members: [{ name: 'reviewer', description: 'Review schema', agentRef: 'worker', context: 'fresh' }],
          requiredChecks: ['schema']
        }
      })
    ],
    { ...agentResources, answerSchema: { kind: 'schema', path: 'lib/schemas/answer.json' } }
  )
}

async function fixture(t) {
  const agentTurns = []
  const teamEffects = []
  const h = await harness(t, {
    onTurn: call => {
      agentTurns.push('scripted-turn')
      call.finish()
    }
  })
  h.ctx.provide(
    'agentTeams',
    Object.fromEntries(
      ['membership', 'listMembers', 'createTask', 'spawnTeammate', 'sendMessage', 'getTask', 'listTasks', 'updateTask', 'waitForChange', 'interrupt'].map(
        name => [
          name,
          () => {
            teamEffects.push(name)
            assert.fail(`unexpected Team effect: ${name}`)
          }
        ]
      )
    )
  )
  return { ...h, agentTurns, teamEffects }
}

const internalArgs = (h, value) => ({
  definitionJson: JSON.stringify(value),
  inputJson: '{}',
  runtimeRoot: h.runtimeRoot,
  rootDir: h.rootDir,
  requestId: randomUUID()
})

async function seedQueued(h, value) {
  const args = internalArgs(h, value)
  const opened = await openBlueprintDomain({ path: h.runtimeRoot })
  try {
    const store = new RunStore(opened.domain)
    const { runId } = await store.createRun(
      { scope: 'run', requestId: args.requestId, payloadFingerprint: sha256(`${args.definitionJson}\0${args.inputJson}`) },
      'frozen-fixture-revision',
      args.definitionJson,
      args.inputJson
    )
    await new RuntimeSnapshots(h.runtimeRoot).freezePackage(runId, value, h.rootDir)
    const record = await store.get(runId)
    assert.equal(record.state, 'queued', 'fixture must start from a valid durable queued Run')
    assert.deepEqual(record.attempts, [])
    return record
  } finally {
    await opened.close()
  }
}

function observed(h, stored) {
  return {
    agentCreates: h.host.calls.length,
    agentTurns: h.agentTurns.length,
    teamEffects: h.teamEffects,
    runs: stored.map(record => ({ state: record.state, results: record.attempts.map(attempt => attempt.result?.evidence) }))
  }
}

function noEffects(h) {
  assert.deepEqual(h.agentTurns, [], 'no scripted model turn after refusal')
  assert.deepEqual(h.teamEffects, [], 'no Team creation, mutation or cancellation compensation')
  assert.deepEqual(h.effects, [], 'no tool effect after refusal')
}

test('W1.3 internal admission refuses undeployed TeamStage before Run or ordinary Agent effects', async t => {
  const h = await fixture(t)
  let refusal
  try {
    await h.service.startRun(internalArgs(h, teamDefinition()))
  } catch (error) {
    refusal = error
  }
  await drain(h)
  const stored = await records(h)
  t.diagnostic(JSON.stringify(observed(h, stored)))
  // The old ordinary fallback creates an Agent even when schema acceptance
  // later fails. A missing rejection alone is not our red oracle.
  assert.equal(h.host.calls.length, 0, 'TeamStage internal admission must refuse before ordinary Agent creation')
  assert.equal(refusal?.code, 'blueprint/preflight-blocked')
  assert.deepEqual(refusal.details.checks, [{ code: 'teamstage-executor-unavailable', status: 'block', nodeId: 'work' }])
  assert.deepEqual(stored, [], 'rejection must precede durable Run admission')
  noEffects(h)
})

test('W1.3 restored queued TeamStage fails with typed reason before ordinary Agent dispatch', async t => {
  const h = await fixture(t)
  const before = await seedQueued(h, teamDefinition())
  await h.service.inspectRun({ runId: before.runId, runtimeRoot: h.runtimeRoot })
  await drain(h)
  const stored = await records(h)
  t.diagnostic(JSON.stringify(observed(h, stored)))
  assert.equal(h.host.calls.length, 0, 'restored TeamStage must refuse before ordinary Agent creation')
  const record = stored.find(record => record.runId === before.runId)
  assert.ok(record, 'restored Run remains durable')
  assert.equal(record.state, 'failed')
  assert.equal(record.log.at(-1).detail.reason, 'teamstage-executor-unavailable')
  assert.deepEqual(record.attempts, [], 'refusal occurs before ordinary dispatch intent')
  assert.equal(record.definitionJson, before.definitionJson, 'guard preserves frozen definition bytes')
  noEffects(h)
})

test('W1.3 legacy internal ordinary AgentTask remains runnable', async t => {
  const h = await fixture(t)
  const admitted = await h.service.startRun(internalArgs(h, definition()))
  await drain(h)
  const record = (await records(h)).find(record => record.runId === admitted.runId)
  assert.equal(record.state, 'succeeded')
  assert.equal(h.host.calls.length, 1)
  assert.equal(h.agentTurns.length, 1)
  assert.deepEqual(h.teamEffects, [])
})

test('W1.3 restored queued legacy ordinary AgentTask remains runnable', async t => {
  const h = await fixture(t)
  const before = await seedQueued(h, definition())
  await h.service.inspectRun({ runId: before.runId, runtimeRoot: h.runtimeRoot })
  await drain(h)
  const record = (await records(h)).find(record => record.runId === before.runId)
  assert.equal(record.state, 'succeeded')
  assert.equal(h.host.calls.length, 1)
  assert.equal(h.agentTurns.length, 1)
  assert.deepEqual(h.teamEffects, [])
})
