/** W3 production-service/JSON-store evidence. No scheduler/executor replacement,
 * no timer sleeps, and no imports of the frozen W1 or additive-red test modules.
 * Seeded cases isolate malformed durable producer results and recovery seams;
 * public admission cases independently prove condition/default-all readiness.
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
import { readyNodes } from '../../src/orchestration/scheduler.ts'

const json = JSON.stringify
const digest = value => createHash('sha256').update(value).digest('hex')
const config = { inputPort: 'predicate', trueBranch: 'yes', falseBranch: 'no' }
function graph(nodes, edges = []) {
  const definition = { schemaVersion: 2, id: 'deterministic-runtime', name: 'Deterministic flow', resources: {}, graph: { nodes, edges } }
  validateDefinition(decodeDefinition(json(definition)))
  return definition
}
const choose = () => ({ id: 'choose', kind: 'condition', inputs: { predicate: 'boolean' }, branches: ['yes', 'no'], condition: { ...config } })
function conditionGraph() {
  return graph(
    [choose(), { id: 'yesPath', kind: 'output' }, { id: 'noPath', kind: 'output' }],
    [
      { kind: 'control', from: 'choose@yes', to: 'yesPath' },
      { kind: 'control', from: 'choose@no', to: 'noPath' }
    ]
  )
}
function forkGraph(strategy) {
  return graph(
    [
      { id: 'source', kind: 'input', outputs: { predicate: 'boolean', value: 'string' } },
      choose(),
      { id: 'yesPath', kind: 'output', inputs: { value: 'string' }, outputs: { value: 'string' } },
      { id: 'noPath', kind: 'output', inputs: { value: 'string' }, outputs: { value: 'string' } },
      {
        id: 'merge',
        kind: 'join',
        ...(strategy === undefined ? {} : { join: strategy }),
        inputs: { yes: 'string', no: 'string' },
        outputs: { yes: 'string', no: 'string' }
      }
    ],
    [
      { kind: 'data', from: 'source.predicate', to: 'choose.predicate' },
      { kind: 'data', from: 'source.value', to: 'yesPath.value' },
      { kind: 'data', from: 'source.value', to: 'noPath.value' },
      { kind: 'control', from: 'choose@yes', to: 'yesPath' },
      { kind: 'control', from: 'choose@no', to: 'noPath' },
      { kind: 'control', from: 'yesPath', to: 'merge' },
      { kind: 'control', from: 'noPath', to: 'merge' },
      { kind: 'data', from: 'yesPath.value', to: 'merge.yes' },
      { kind: 'data', from: 'noPath.value', to: 'merge.no' }
    ]
  )
}
function mergeGraph({ controls = false, sharedPort = false, strategy } = {}) {
  return graph(
    [
      { id: 'left', kind: 'input', outputs: { value: 'string' } },
      { id: 'right', kind: 'input', outputs: { value: 'string' } },
      {
        id: 'merge',
        kind: 'join',
        ...(strategy === undefined ? {} : { join: strategy }),
        inputs: sharedPort ? { value: 'string' } : { left: 'string', right: 'string' },
        outputs: sharedPort ? { value: 'string' } : { left: 'string', right: 'string' }
      }
    ],
    [
      { kind: 'data', from: 'left.value', to: `merge.${sharedPort ? 'value' : 'left'}` },
      { kind: 'data', from: 'right.value', to: `merge.${sharedPort ? 'value' : 'right'}` },
      ...(controls
        ? [
            { kind: 'control', from: 'left', to: 'merge' },
            { kind: 'control', from: 'right', to: 'merge' }
          ]
        : [])
    ]
  )
}
async function fixture(t, definition) {
  const root = mkdtempSync(join(tmpdir(), 'bp-deterministic-runtime-'))
  const packageRoot = join(root, '.xuanling', 'workflows', definition.id),
    workspaceRoot = root,
    runtimeRoot = join(root, '.xuanling')
  mkdirSync(packageRoot, { recursive: true })
  writeFileSync(join(packageRoot, 'blueprint.json'), json(definition))
  const agentCalls = []
  let fiber
  const h = { root, packageRoot, runtimeRoot, definition, agentCalls }
  h.close = async () => {
    if (fiber) {
      const previous = fiber
      fiber = undefined
      await previous.dispose()
    }
  }
  h.reopen = async () => {
    await h.close()
    const ctx = new Context()
    ctx.provide('agents', {
      async create() {
        agentCalls.push('create')
        throw new Error('unexpected structural Agent dispatch')
      }
    })
    fiber = await ctx.plugin(BlueprintService, { workspaceRoot, runtimeRoot })
    h.service = ctx.blueprint
    h.handle = await h.service.runtimeFor(runtimeRoot)
    await h.handle.driverTail
  }
  t.after(async () => {
    try {
      await h.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  await h.reopen()
  return h
}
async function publicStart(h, input, requestId = randomUUID()) {
  const doc = await h.service.loadDefinition({ blueprintId: h.definition.id })
  const args = { blueprintId: doc.blueprintId, expectedRevision: doc.documentRevision, inputJson: json(input), requestId }
  const report = await h.service.preflightRun({ blueprintId: args.blueprintId, expectedRevision: args.expectedRevision, inputJson: args.inputJson })
  assert.equal(report.canStart, true, 'configured deterministic definition must be runnable through public preflight')
  const admission = await h.service.startRun(args)
  await h.handle.driverTail
  assert.deepEqual(h.agentCalls, [], 'structural nodes must never dispatch a business Agent')
  return { args, admission, record: await h.handle.store.get(admission.runId) }
}
async function seedRun(h, input = {}) {
  const definitionJson = json(h.definition),
    inputJson = json(input)
  return (
    await h.handle.store.createRun(
      { scope: 'run', requestId: randomUUID(), payloadFingerprint: digest(`${definitionJson}\0${inputJson}`) },
      'seed-semantic',
      definitionJson,
      inputJson
    )
  ).runId
}
async function seedParent(h, runId, nodeId, state, outcome = { outputs: {} }) {
  if (state === 'skipped') {
    await h.handle.store.transition(runId, draft => {
      draft.attempts.push({ attemptId: `skipped-${nodeId}`, nodeId, attempt: 1, state: 'skipped' })
    })
    return
  }
  const node = h.definition.graph.nodes.find(node => node.id === nodeId)
  assert.ok(node, 'seed must refer to a real definition node')
  const intent = await h.handle.store.recordIntent(runId, { nodeId, kind: node.kind })
  await h.handle.store.recordResult(runId, intent.attemptId, { ok: state === 'succeeded', outcome, evidence: 'fixture-parent-result' })
}
async function drive(h, runId) {
  await h.service.driveRun(h.handle, runId, h.definition)
  assert.deepEqual(h.agentCalls, [])
  return await h.handle.store.get(runId)
}
async function rejectAdmissionAndDriveExisting(h, input, code) {
  const document = await h.service.loadDefinition({ blueprintId: h.definition.id })
  const args = { blueprintId: document.blueprintId, expectedRevision: document.documentRevision, inputJson: json(input) }
  const report = await h.service.preflightRun(args)
  assert.equal(report.canStart, false)
  assert.ok(report.checks.some(check => check.code === code && check.status === 'block'))
  await assert.rejects(h.service.startRun({ ...args, requestId: randomUUID() }), { code: 'blueprint/preflight-blocked' })
  const { runId } = await h.handle.store.createRun(
    { scope: 'run', requestId: randomUUID(), payloadFingerprint: digest(document.definitionJson + args.inputJson) },
    document.semanticRevision,
    document.definitionJson,
    args.inputJson
  )
  await h.service.driveRun(h.handle, runId, h.definition)
  return { record: await h.handle.store.get(runId) }
}
function attemptOf(record, nodeId, message = 'required durable Attempt must exist') {
  const attempt = record.attempts.findLast(attempt => attempt.nodeId === nodeId)
  assert.ok(attempt, `${nodeId}: ${message}`)
  return attempt
}
function successful(record, nodeId) {
  const attempt = attemptOf(record, nodeId)
  assert.equal(attempt.state, 'succeeded')
  assert.ok(attempt.intent, 'success must have a durable intent')
  assert.ok(attempt.result, 'success must have an authoritative durable result')
  assert.equal(attempt.result.ok, true)
  assert.ok(attempt.result.seq > attempt.intent.seq)
  return attempt
}
function availableDiagnostics(attempt) {
  assert.ok(attempt.diagnostics, 'dispatched Attempt must preserve durable diagnostics')
  assert.equal(attempt.diagnostics.status, 'available')
  return attempt.diagnostics
}
async function rejected(h, record, nodeId, code) {
  assert.equal(record.state, 'failed')
  const attempt = attemptOf(record, nodeId, 'typed failure must persist an Attempt, not only fail the Run')
  assert.equal(attempt.state, 'failed')
  assert.ok(attempt.intent)
  assert.ok(attempt.result)
  assert.equal(attempt.result.ok, false)
  assert.equal(attempt.result.outcome.kind, code)
  const inspection = await h.service.inspectRun({ runId: record.runId })
  const projected = inspection.attempts.find(attempt => attempt.attemptId === attemptOf(record, nodeId).attemptId)
  assert.ok(projected, 'failure must have an inspectRun projection')
  assert.equal(projected.errorCode, code)
  assert.equal(projected.outputJson, undefined)
  assert.doesNotMatch(json(projected.diagnostics), /PRIVATE_INPUT_MARKER/)
  return attempt
}

for (const strategy of [undefined, 'all']) {
  for (const predicate of [true, false]) {
    test(`C-05/C-06 public flow: boolean ${predicate}, ${strategy ?? 'default'} all merges only selected data/control parents`, async t => {
      const h = await fixture(t, forkGraph(strategy))
      const { record, args, admission } = await publicStart(h, { predicate, value: 'USER_VALUE' })
      assert.equal(record.state, 'succeeded')
      const selected = predicate ? 'yes' : 'no',
        unselected = predicate ? 'no' : 'yes'
      const choice = successful(record, 'choose')
      assert.equal(choice.result.outcome.branch, selected)
      assert.equal(choice.result.outcome.value, predicate)
      assert.equal(availableDiagnostics(choice).input.sha256, digest(json({ predicate })))
      successful(record, `${selected}Path`)
      const skipped = attemptOf(record, `${unselected}Path`)
      assert.equal(skipped.state, 'skipped')
      assert.equal(skipped.intent, undefined)
      assert.equal(skipped.result, undefined, 'unselected path has no source output to read')
      const merged = successful(record, 'merge')
      assert.deepEqual(merged.result.outcome.outputs, { [selected]: 'USER_VALUE' })
      assert.deepEqual(merged.result.outcome.value, { [selected]: 'USER_VALUE' })
      assert.equal(availableDiagnostics(merged).input.sha256, digest(json({ [selected]: 'USER_VALUE' })))
      assert.equal(
        record.attempts.some(attempt => attempt.state === 'waiting_input'),
        false
      )
      const inspection = await h.service.inspectRun({ runId: record.runId })
      const projected = inspection.attempts.find(attempt => attempt.nodeId === 'merge')
      assert.ok(projected)
      assert.equal(typeof projected.outputJson, 'string', 'successful join must project declared outputs')
      assert.deepEqual(JSON.parse(projected.outputJson).outputs, { [selected]: 'USER_VALUE' })
      const before = structuredClone(record)
      await drive(h, record.runId)
      const replay = await h.service.startRun(args)
      await h.handle.driverTail
      assert.equal(replay.replayed, true)
      assert.equal(replay.runId, admission.runId)
      assert.deepEqual(await h.handle.store.get(record.runId), before, 'terminal drive and command replay cannot redispatch')
      await h.reopen()
      assert.deepEqual(await h.handle.store.get(record.runId), before, 'terminal restart preserves branch/Attempt IDs/seq')
    })
  }
}
for (const [label, input] of [
  ['string', { predicate: 'true', secret: 'PRIVATE_INPUT_MARKER' }],
  ['number', { predicate: 1 }],
  ['null', { predicate: null }],
  ['absent', {}],
  ['whole null', null],
  ['array', [true]]
]) {
  test(`C-05 strict predicate: ${label} persists condition-input-invalid without dispatching downstream`, async t => {
    const h = await fixture(t, conditionGraph())
    const { record } = await rejectAdmissionAndDriveExisting(h, input, 'condition-input-invalid')
    await rejected(h, record, 'choose', 'condition-input-invalid')
    assert.equal(record.attempts.length, 1)
    assert.equal(
      record.attempts.some(attempt => attempt.state === 'waiting_input'),
      false
    )
    const before = structuredClone(record)
    await h.reopen()
    assert.deepEqual(await h.handle.store.get(record.runId), before)
  })
}
test('C-05 bound predicate: declared boolean but malformed settled producer result is rejected durably', async t => {
  const definition = graph(
    [{ id: 'source', kind: 'input', outputs: { predicate: 'boolean' } }, choose()],
    [{ kind: 'data', from: 'source.predicate', to: 'choose.predicate' }]
  )
  const h = await fixture(t, definition)
  const runId = await seedRun(h, { predicate: true })
  await seedParent(h, runId, 'source', 'succeeded', { outputs: { predicate: 'false' } })
  const record = await drive(h, runId)
  const attempt = await rejected(h, record, 'choose', 'condition-input-invalid')
  assert.deepEqual(attempt.diagnostics, { status: 'unavailable' }, 'incomplete rejected bindings cannot invent a dispatch digest')
})
for (const controls of [false, true]) {
  test(`C-06 selected-only ${controls ? 'control+data' : 'data'} join: skipped parent contributes no output`, async t => {
    const h = await fixture(t, mergeGraph({ controls }))
    const runId = await seedRun(h)
    await seedParent(h, runId, 'left', 'succeeded', { outputs: { value: 'SELECTED' } })
    await seedParent(h, runId, 'right', 'skipped')
    const record = await drive(h, runId)
    assert.equal(record.state, 'succeeded')
    assert.deepEqual(successful(record, 'merge').result.outcome.outputs, { left: 'SELECTED' })
    assert.equal(attemptOf(record, 'right').result, undefined)
  })
}
test('C-06 shared target port: a skipped edge cannot erase a successful selected binding', async t => {
  const h = await fixture(t, mergeGraph({ sharedPort: true }))
  const runId = await seedRun(h)
  await seedParent(h, runId, 'left', 'succeeded', { outputs: { value: 'SELECTED' } })
  await seedParent(h, runId, 'right', 'skipped')
  const record = await drive(h, runId)
  assert.equal(record.state, 'succeeded')
  assert.deepEqual(successful(record, 'merge').result.outcome.outputs, { value: 'SELECTED' })
})
test('C-06 selected all: both successful parents retain typed values', async t => {
  const h = await fixture(t, mergeGraph({ controls: true }))
  const runId = await seedRun(h)
  await seedParent(h, runId, 'left', 'succeeded', { outputs: { value: 'LEFT' } })
  await seedParent(h, runId, 'right', 'succeeded', { outputs: { value: 'RIGHT' } })
  const record = await drive(h, runId)
  assert.equal(record.state, 'succeeded')
  assert.deepEqual(successful(record, 'merge').result.outcome.outputs, { left: 'LEFT', right: 'RIGHT' })
})
test('C-06 no selected parent: all skipped data/control parents skip the join without an intent', async t => {
  const h = await fixture(t, mergeGraph({ controls: true }))
  const runId = await seedRun(h)
  await seedParent(h, runId, 'left', 'skipped')
  await seedParent(h, runId, 'right', 'skipped')
  const record = await drive(h, runId)
  assert.equal(record.state, 'succeeded')
  const merged = attemptOf(record, 'merge')
  assert.equal(merged.state, 'skipped')
  assert.equal(merged.intent, undefined)
  assert.equal(merged.result, undefined)
})
test('C-06 selected parent failure remains Run failure; merge is never dispatched', async t => {
  const h = await fixture(t, mergeGraph())
  const runId = await seedRun(h)
  await seedParent(h, runId, 'left', 'failed', { kind: 'failed' })
  await seedParent(h, runId, 'right', 'skipped')
  const record = await drive(h, runId)
  assert.equal(record.state, 'failed')
  assert.equal(
    record.attempts.some(attempt => attempt.nodeId === 'merge'),
    false
  )
})
test('C-06 scheduler production oracle: default all waits for selected control parents, not only successful data parents', () => {
  const definition = graph(
    [
      { id: 'data', kind: 'input', outputs: { value: 'string' } },
      { id: 'approval', kind: 'humanDecision' },
      { id: 'merge', kind: 'join', inputs: { value: 'string' }, outputs: { value: 'string' } }
    ],
    [
      { kind: 'data', from: 'data.value', to: 'merge.value' },
      { kind: 'control', from: 'approval', to: 'merge' }
    ]
  )
  const snapshot = {
    attempts: [
      { nodeId: 'data', states: ['succeeded'] },
      { nodeId: 'approval', states: ['waiting_input'] }
    ],
    decisions: {}
  }
  const pending = readyNodes(definition, snapshot)
  assert.equal(pending.ready.includes('merge'), false)
  assert.ok(pending.blocked.includes('merge'))
  assert.ok(pending.joinsPending.includes('merge'))
  snapshot.attempts[1].states = ['succeeded']
  assert.ok(readyNodes(definition, snapshot).ready.includes('merge'))
})
test('C-06 control-only join uses the selected sibling while skipped sibling has no result', async t => {
  const definition = graph(
    [
      { id: 'left', kind: 'input' },
      { id: 'right', kind: 'input' },
      { id: 'merge', kind: 'join' }
    ],
    [
      { kind: 'control', from: 'left', to: 'merge' },
      { kind: 'control', from: 'right', to: 'merge' }
    ]
  )
  const h = await fixture(t, definition)
  const runId = await seedRun(h)
  await seedParent(h, runId, 'left', 'succeeded')
  await seedParent(h, runId, 'right', 'skipped')
  const record = await drive(h, runId)
  assert.equal(record.state, 'succeeded')
  assert.deepEqual(successful(record, 'merge').result.outcome.outputs, {})
})
test('C-06 typed binding: wrong actual string port value creates binding-invalid Attempt with static projection', async t => {
  const h = await fixture(t, mergeGraph())
  const runId = await seedRun(h)
  await seedParent(h, runId, 'left', 'succeeded', { outputs: { value: 42 } })
  await seedParent(h, runId, 'right', 'skipped')
  const record = await drive(h, runId)
  const attempt = await rejected(h, record, 'merge', 'binding-invalid')
  assert.deepEqual(attempt.diagnostics, { status: 'unavailable' })
})
for (const [label, input, code] of [
  ['missing', {}, 'input-missing'],
  ['wrong type', { value: 1 }, 'input-invalid']
]) {
  test(`C-06 typed input ${label}: failed Attempt survives restart with static errorCode`, async t => {
    const h = await fixture(t, graph([{ id: 'source', kind: 'input', inputs: { value: 'string' }, outputs: { value: 'string' } }]))
    const { record } = await rejectAdmissionAndDriveExisting(h, input, code)
    await rejected(h, record, 'source', code)
    const before = structuredClone(record)
    await h.reopen()
    assert.deepEqual(await h.handle.store.get(record.runId), before)
    await rejected(h, await h.handle.store.get(record.runId), 'source', code)
  })
}
for (const [label, outputs, code] of [
  ['missing same-name value', { absent: 'string' }, 'output-missing'],
  ['actual type mismatch', { value: 'number' }, 'output-invalid']
]) {
  test(`C-06 typed join output ${label}: durable failure never substitutes the whole input`, async t => {
    const h = await fixture(
      t,
      graph(
        [
          { id: 'source', kind: 'input', outputs: { value: 'string' } },
          { id: 'merge', kind: 'join', inputs: { value: 'string' }, outputs }
        ],
        [{ kind: 'data', from: 'source.value', to: 'merge.value' }]
      )
    )
    const { record } = await publicStart(h, { value: 'PRIVATE_INPUT_MARKER' })
    await rejected(h, record, 'merge', code)
    successful(record, 'source')
  })
}
for (const [type, value] of [
  ['json', null],
  ['json', [1, false, { text: 'USER_VALUE' }]],
  ['number', 7],
  ['boolean', false],
  ['string', 'USER_VALUE']
]) {
  test(`C-06/C-08 pass-through preserves actual ${type}/${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value} value and canonical digest`, async t => {
    const h = await fixture(
      t,
      graph(
        [
          { id: 'source', kind: 'input', outputs: { value: type } },
          { id: 'sink', kind: 'output', inputs: { value: type }, outputs: { value: type } }
        ],
        [{ kind: 'data', from: 'source.value', to: 'sink.value' }]
      )
    )
    const { record } = await publicStart(h, { value })
    assert.equal(record.state, 'succeeded')
    const sink = successful(record, 'sink')
    assert.deepEqual(sink.result.outcome.outputs, { value })
    assert.equal(availableDiagnostics(sink).input.sha256, digest(json({ value })))
    assert.equal(availableDiagnostics(sink).input.bytes, Buffer.byteLength(json({ value })))
  })
}
test('C-05/C-06/C-08 restart resumes an already committed branch without re-evaluating changed predicate input', async t => {
  const h = await fixture(t, forkGraph())
  const runId = await seedRun(h, { predicate: false, value: 'RESUME_VALUE' })
  await seedParent(h, runId, 'source', 'succeeded', { outputs: { predicate: false, value: 'RESUME_VALUE' } })
  // Authoritative settled branch deliberately differs from the input. Recovery
  // must consume the committed result, not reinterpret or rewrite history.
  await seedParent(h, runId, 'choose', 'succeeded', { branch: 'yes', outputs: {}, value: true })
  const before = successful(await h.handle.store.get(runId), 'choose')
  await h.reopen()
  const record = await h.handle.store.get(runId)
  assert.equal(record.state, 'succeeded')
  assert.deepEqual(successful(record, 'choose'), before)
  assert.equal(record.attempts.filter(attempt => attempt.nodeId === 'choose').length, 1)
  assert.equal(attemptOf(record, 'noPath').state, 'skipped')
  assert.deepEqual(successful(record, 'merge').result.outcome.outputs, { yes: 'RESUME_VALUE' })
  assert.deepEqual(h.agentCalls, [])
})
test('C-08 unknown condition intent after restart stays recovery_required, never rejudges or dispatches', async t => {
  const h = await fixture(t, conditionGraph())
  const runId = await seedRun(h, { predicate: true })
  const intent = await h.handle.store.recordIntent(runId, { nodeId: 'choose', kind: 'condition' })
  await h.reopen()
  const record = await h.handle.store.get(runId)
  assert.equal(record.state, 'recovery_required')
  assert.equal(record.attempts.length, 1)
  const choice = attemptOf(record, 'choose')
  assert.equal(choice.attemptId, intent.attemptId)
  assert.equal(choice.state, 'recovery_required')
  assert.equal(choice.result, undefined)
  assert.deepEqual(h.agentCalls, [])
})
test('C-08 cancellation before deterministic dispatch creates no condition/join Attempt', async t => {
  const h = await fixture(t, forkGraph())
  const runId = await seedRun(h, { predicate: true, value: 'USER_VALUE' })
  await h.handle.store.requestCancel(runId)
  const record = await drive(h, runId)
  assert.equal(record.state, 'cancelled')
  assert.deepEqual(record.attempts, [])
  const before = structuredClone(record)
  await h.reopen()
  assert.deepEqual(await h.handle.store.get(runId), before)
})
test('C-06/C-08 humanDecision waiting/restart/duplicate decision still gates default-all join through public service', async t => {
  const definition = graph(
    [
      { id: 'approval', kind: 'humanDecision' },
      { id: 'approved', kind: 'output' },
      { id: 'rejected', kind: 'output' },
      { id: 'merge', kind: 'join' }
    ],
    [
      { kind: 'control', from: 'approval@approve', to: 'approved' },
      { kind: 'control', from: 'approval@reject', to: 'rejected' },
      { kind: 'control', from: 'approved', to: 'merge' },
      { kind: 'control', from: 'rejected', to: 'merge' }
    ]
  )
  const h = await fixture(t, definition)
  const { record } = await publicStart(h, {})
  assert.equal(record.state, 'waiting_input')
  assert.equal(record.attempts.length, 1)
  await h.reopen()
  assert.deepEqual(await h.handle.store.get(record.runId), record, 'restart does not dispatch waiting human decisions')
  const args = { runId: record.runId, decisionId: 'approve-once', action: 'approve' }
  const decision = await h.service.decide(args)
  assert.equal(decision.applied, true)
  await h.handle.driverTail
  const completed = await h.handle.store.get(record.runId)
  assert.equal(completed.state, 'succeeded')
  assert.equal(successful(completed, 'approval').result.outcome.branch, 'approve')
  assert.equal(attemptOf(completed, 'rejected').state, 'skipped')
  successful(completed, 'merge')
  assert.equal((await h.service.decide(args)).applied, false)
  assert.deepEqual(await h.handle.store.get(record.runId), completed)
})
test('C-01/C-06 join-any is rejected as a definition-invalid hard break before admission', () => {
  assert.throws(
    () => mergeGraph({ strategy: 'any' }),
    error => error.code === 'DEFINITION_INVALID' && error.issues.some(issue => issue.pointer === '/graph/nodes/2/join')
  )
})
