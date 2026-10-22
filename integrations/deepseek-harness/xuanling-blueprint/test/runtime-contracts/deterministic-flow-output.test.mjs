/**
 * W3 additive C-06 oracle: a selected successful parent can still lack the
 * required output. Missing merge Attempts must be assertion failures, never
 * TypeErrors disguised as contract reds. W1 oracles remain unchanged.
 *
 * Reuses the flow-ui oracle's real configured BlueprintService / RunStore /
 * seeded driveRun seam. Seeding isolates execution from W2's intentional join
 * admission block; it does NOT prove preflight or public admission support.
 * No executor/scheduler replacement, sleeps, build artifacts or Agent policy
 * stubs. Structural nodes must not compose a business Agent.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { BlueprintService } from '../../src/index.ts'
import { decodeDefinition, validateDefinition } from '../../src/definition/index.ts'

const json = JSON.stringify
const staticBindingError = /^(?:input|binding|output)-(?:invalid|unavailable|missing)$/

function joinDefinition() {
  const value = {
    schemaVersion: 2,
    id: 'deterministic-flow-output',
    name: 'Selected parent missing output',
    resources: {},
    graph: {
      nodes: [
        { id: 'left', kind: 'input', outputs: { value: 'string' } },
        { id: 'right', kind: 'input', outputs: { value: 'string' } },
        { id: 'merge', kind: 'join', join: 'all', inputs: { left: 'string', right: 'string' }, outputs: { left: 'string', right: 'string' } }
      ],
      edges: [
        { kind: 'data', from: 'left.value', to: 'merge.left' },
        { kind: 'data', from: 'right.value', to: 'merge.right' }
      ]
    }
  }
  // Existing readable vocabulary, not an invented future codec capability.
  validateDefinition(decodeDefinition(json(value)))
  return value
}

function aggregateJoinDefinition() {
  const value = {
    schemaVersion: 2,
    id: 'deterministic-flow-aggregate',
    name: 'Aggregate join output',
    resources: {},
    graph: {
      nodes: [
        { id: 'static', kind: 'input', outputs: { review: 'string' } },
        { id: 'security', kind: 'input', outputs: { review: 'string' } },
        { id: 'tests', kind: 'input', outputs: { review: 'string' } },
        { id: 'architecture', kind: 'input', outputs: { review: 'string' } },
        {
          id: 'parallel-reviews',
          kind: 'join',
          join: 'all',
          inputs: { static: 'string', security: 'string', tests: 'string', architecture: 'string' },
          outputs: { reviews: 'array' }
        }
      ],
      edges: [
        { kind: 'data', from: 'static.review', to: 'parallel-reviews.static' },
        { kind: 'data', from: 'security.review', to: 'parallel-reviews.security' },
        { kind: 'data', from: 'tests.review', to: 'parallel-reviews.tests' },
        { kind: 'data', from: 'architecture.review', to: 'parallel-reviews.architecture' }
      ]
    }
  }
  validateDefinition(decodeDefinition(json(value)))
  return value
}

async function serviceFixture(t, definition) {
  const root = mkdtempSync(join(tmpdir(), 'bp-selected-output-'))
  const packageRoot = join(root, '.xuanling', 'workflows', definition.id)
  const workspaceRoot = root
  const runtimeRoot = join(root, '.xuanling')
  mkdirSync(packageRoot, { recursive: true })
  writeFileSync(join(packageRoot, 'blueprint.json'), json(definition))
  const ctx = new Context()
  const agentCalls = []
  ctx.provide('agents', {
    async create() {
      agentCalls.push('create')
      throw new Error('fixture: unexpected structural Agent dispatch')
    }
  })
  const fiber = await ctx.plugin(BlueprintService, {
    workspaceRoot,
    runtimeRoot
  })
  t.after(async () => {
    try {
      await fiber.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  const service = ctx.blueprint
  const handle = await service.runtimeFor(runtimeRoot)
  return { service, handle, agentCalls }
}

async function seedSelectedParentWithoutOutput(h, definition) {
  const definitionJson = json(definition)
  const inputJson = '{}'
  const payloadFingerprint = createHash('sha256').update(`${definitionJson}\0${inputJson}`).digest('hex')
  const { runId } = await h.handle.store.createRun(
    {
      scope: 'run',
      requestId: randomUUID(),
      payloadFingerprint
    },
    'seed-semantic',
    definitionJson,
    inputJson
  )
  const left = await h.handle.store.recordIntent(runId, { nodeId: 'left', kind: 'input' })
  await h.handle.store.recordResult(runId, left.attemptId, {
    ok: true,
    outcome: { outputs: {} },
    evidence: 'fixture-selected-parent-result'
  })
  await h.handle.store.transition(runId, draft => {
    draft.attempts.push({ attemptId: 'skipped-right', nodeId: 'right', attempt: 1, state: 'skipped' })
  })
  return runId
}

async function seedAggregateParents(h, definition) {
  const definitionJson = json(definition)
  const inputJson = '{}'
  const payloadFingerprint = createHash('sha256').update(`${definitionJson}\0${inputJson}`).digest('hex')
  const { runId } = await h.handle.store.createRun(
    {
      scope: 'run',
      requestId: randomUUID(),
      payloadFingerprint
    },
    'seed-semantic',
    definitionJson,
    inputJson
  )
  for (const [nodeId, value] of [
    ['static', 'STATIC_REVIEW'],
    ['security', 'SECURITY_REVIEW'],
    ['tests', 'TEST_REVIEW'],
    ['architecture', 'ARCHITECTURE_REVIEW']
  ]) {
    const intent = await h.handle.store.recordIntent(runId, { nodeId, kind: 'input' })
    await h.handle.store.recordResult(runId, intent.attemptId, {
      ok: true,
      outcome: { outputs: { review: value } },
      evidence: 'fixture-aggregate-parent-result'
    })
  }
  return runId
}

function assertControlledParents(record) {
  const left = record.attempts.find(attempt => attempt.nodeId === 'left')
  assert.ok(left, 'CONTROL: the selected parent is durably present')
  assert.equal(left.state, 'succeeded')
  assert.ok(left.result, 'CONTROL: selected success has an authoritative durable result')
  assert.equal(left.result.ok, true)
  assert.deepEqual(left.result.outcome, { outputs: {} })
  assert.equal(Object.hasOwn(left.result.outcome.outputs, 'value'), false, 'CONTROL: the selected parent truly lacks the required source output')
  const right = record.attempts.find(attempt => attempt.nodeId === 'right')
  assert.ok(right, 'CONTROL: the other parent is durably present')
  assert.equal(right.state, 'skipped')
  assert.equal(right.intent, undefined)
  assert.equal(right.result, undefined, 'CONTROL: skipped parent also has no result to bind')
}

test('C-06 selected output missing: real driver persists a failed merge Attempt and inspectRun exposes a static binding error', async t => {
  const definition = joinDefinition()
  const h = await serviceFixture(t, definition)
  const runId = await seedSelectedParentWithoutOutput(h, definition)
  const seeded = await h.handle.store.get(runId)
  assertControlledParents(seeded)
  assert.equal(
    seeded.attempts.some(attempt => attempt.nodeId === 'merge'),
    false,
    'CONTROL: the fixture must not manufacture the merge Attempt'
  )

  await h.service.driveRun(h.handle, runId, definition)
  const record = await h.handle.store.get(runId)
  assertControlledParents(record)
  assert.deepEqual(h.agentCalls, [], 'CONTROL: missing structural output never dispatches an Agent')
  assert.equal(record.state, 'failed', 'C-06 missing selected input cannot succeed or remain unsettled')
  const merge = record.attempts.find(attempt => attempt.nodeId === 'merge')
  assert.ok(merge, 'C-06 MISSING_OUTPUT_ATTEMPT_ABSENT: binding rejection must leave a durable failed merge Attempt')
  assert.equal(merge.state, 'failed', 'C-06 missing selected output is not an unselected skipped join')
  assert.ok(merge.result, 'C-06 MISSING_OUTPUT_RESULT_ABSENT: the rejection must be durably settled')
  assert.equal(merge.result.ok, false)
  assert.equal(typeof merge.result.outcome?.kind, 'string', 'C-06 the durable binding failure must have a static kind')
  assert.match(merge.result.outcome.kind, staticBindingError, 'C-06 MISSING_OUTPUT_UNTYPED: generic failed/unsupported-node is not a binding/output diagnosis')

  const view = await h.service.inspectRun({ runId })
  assert.equal(view.state, 'failed')
  const projected = view.attempts.find(attempt => attempt.nodeId === 'merge')
  assert.ok(projected, 'C-06 MISSING_OUTPUT_PROJECTION_ABSENT: inspectRun must retain the failed merge Attempt')
  assert.equal(projected.state, 'failed')
  assert.equal(typeof projected.errorCode, 'string', 'C-06 inspectRun must expose the static binding failure code')
  assert.match(projected.errorCode, staticBindingError, 'C-06 MISSING_OUTPUT_PROJECTION_UNTYPED: failed alone is not the input/binding/output error code')
  assert.equal(projected.errorCode, merge.result.outcome.kind, 'C-06 inspectRun errorCode must project the durable failure, not invent another diagnosis')
  assert.equal(projected.outputJson, undefined, 'C-06 rejected binding must not project a successful output')
})

test('C-03 aggregate join: a named array output collects all selected input ports in declaration order', async t => {
  const definition = aggregateJoinDefinition()
  const h = await serviceFixture(t, definition)
  const runId = await seedAggregateParents(h, definition)

  await h.service.driveRun(h.handle, runId, definition)
  const record = await h.handle.store.get(runId)
  assert.equal(record.state, 'succeeded', 'C-03 aggregate join must settle the saved review graph')
  const merge = record.attempts.find(attempt => attempt.nodeId === 'parallel-reviews')
  assert.ok(merge, 'C-03 aggregate join must persist its Attempt')
  assert.equal(merge.state, 'succeeded')
  assert.deepEqual(merge.result?.outcome?.outputs, {
    reviews: ['STATIC_REVIEW', 'SECURITY_REVIEW', 'TEST_REVIEW', 'ARCHITECTURE_REVIEW']
  })
})
