/** C-06/C-08 nominal-label compatibility: saved public admission, actual driver,
 * durable JSON store and inspectRun. Nominal labels are opaque, not invented
 * shape schemas. Seeded producer cases isolate missing results only; no fake
 * scheduler/executor, hidden assertions, sleeps or frozen-oracle imports.
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
const nominal = 'DomainPayload'
const values = [
  ['object', { text: 'PUBLIC_FIXTURE', nested: { enabled: false, empty: null } }],
  ['array', [0, 'PUBLIC_FIXTURE', false, null, { nested: [1, 2] }]],
  ['string', 'PUBLIC_FIXTURE'], ['number', 23.5], ['boolean', false], ['null', null],
]
function graph(nodes, edges = []) {
  return { schemaVersion: 1, id: 'nominal-wire', name: 'Nominal wire compatibility', resources: {}, graph: { nodes, edges } }
}
function passThrough(type = nominal) {
  return graph([
    { id: 'source', kind: 'input', outputs: { payload: type } },
    { id: 'sink', kind: 'output', inputs: { payload: type }, outputs: { payload: type } },
  ], [{ kind: 'data', from: 'source.payload', to: 'sink.payload' }])
}
function selectedJoin() {
  return graph([
    { id: 'source', kind: 'input', outputs: { predicate: 'boolean', payload: nominal } },
    { id: 'choose', kind: 'condition', inputs: { predicate: 'boolean' }, branches: ['yes', 'no'],
      condition: { inputPort: 'predicate', trueBranch: 'yes', falseBranch: 'no' } },
    { id: 'yesPath', kind: 'output', inputs: { payload: nominal }, outputs: { payload: nominal } },
    { id: 'noPath', kind: 'output', inputs: { payload: nominal }, outputs: { payload: nominal } },
    // Both edges target the same name: a skipped sibling cannot omit it.
    { id: 'merge', kind: 'join', inputs: { payload: nominal }, outputs: { payload: nominal } },
    { id: 'sink', kind: 'output', inputs: { payload: nominal }, outputs: { payload: nominal } },
  ], [
    { kind: 'data', from: 'source.predicate', to: 'choose.predicate' },
    { kind: 'data', from: 'source.payload', to: 'yesPath.payload' },
    { kind: 'data', from: 'source.payload', to: 'noPath.payload' },
    { kind: 'control', from: 'choose@yes', to: 'yesPath' },
    { kind: 'control', from: 'choose@no', to: 'noPath' },
    { kind: 'control', from: 'yesPath', to: 'merge' },
    { kind: 'control', from: 'noPath', to: 'merge' },
    { kind: 'data', from: 'yesPath.payload', to: 'merge.payload' },
    { kind: 'data', from: 'noPath.payload', to: 'merge.payload' },
    { kind: 'data', from: 'merge.payload', to: 'sink.payload' },
  ])
}
async function fixture(t, definition) {
  validateDefinition(decodeDefinition(json(definition)))
  const root = mkdtempSync(join(tmpdir(), 'bp-nominal-wire-'))
  const packageRoot = join(root, 'package'), runtimeRoot = join(root, 'runtime')
  mkdirSync(packageRoot, { recursive: true })
  writeFileSync(join(packageRoot, 'blueprint.json'), json(definition))
  let fiber
  const h = { definition, runtimeRoot }
  h.close = async () => {
    if (fiber) { const previous = fiber; fiber = undefined; await previous.dispose() }
  }
  h.reopen = async () => {
    await h.close()
    const ctx = new Context()
    fiber = await ctx.plugin(BlueprintService, { blueprints: { [definition.id]: packageRoot }, runtimeRoot })
    h.service = ctx.blueprint
    h.handle = await h.service.runtimeFor(runtimeRoot)
    await h.handle.driverTail
  }
  t.after(async () => { try { await h.close() } finally { rmSync(root, { recursive: true, force: true }) } })
  await h.reopen()
  return h
}
async function start(h, input, requestId = randomUUID()) {
  const document = await h.service.loadDefinition({ blueprintId: h.definition.id })
  const args = { blueprintId: document.blueprintId, expectedRevision: document.documentRevision, inputJson: json(input), requestId }
  const report = await h.service.preflightRun({ blueprintId: args.blueprintId, expectedRevision: args.expectedRevision, inputJson: args.inputJson })
  assert.equal(report.canStart, true, 'public preflight must admit the saved valid definition (not a fixture/import red)')
  const admission = await h.service.startRun(args)
  assert.equal(admission.replayed, false)
  await h.handle.driverTail
  const record = await h.handle.store.get(admission.runId)
  assert.equal(record.definitionRevision, document.semanticRevision)
  assert.equal(record.inputRef, args.inputJson)
  assert.deepEqual(JSON.parse(record.definitionJson), JSON.parse(document.definitionJson))
  return { args, document, admission, record, preflightCanStart: report.canStart }
}
function attempt(record, nodeId) {
  const value = record.attempts.findLast(item => item.nodeId === nodeId)
  assert.ok(value, `${nodeId}: durable Attempt must exist, never dereference an absent result`)
  return value
}
async function success(t, h, started, expectedByNode) {
  const inspection = await h.service.inspectRun({ runId: started.record.runId })
  const source = inspection.attempts.find(item => item.nodeId === 'source')
  // Static facts only: no raw input, prompt, roots or tool arguments in receipts.
  t.diagnostic(json({ oracle: 'nominal-runtime', preflightCanStart: started.preflightCanStart,
    state: inspection.state, sourceState: source?.state, sourceErrorCode: source?.errorCode }))
  assert.equal(started.record.state, 'succeeded', 'NOMINAL_RUNTIME_REJECTED: admitted opaque JSON label must survive the real driver')
  assert.equal(inspection.state, 'succeeded')
  for (const [nodeId, outputs] of Object.entries(expectedByNode)) {
    const value = attempt(started.record, nodeId)
    assert.equal(value.state, 'succeeded')
    assert.ok(value.intent)
    assert.ok(value.result)
    assert.equal(value.result.ok, true)
    assert.ok(value.result.seq > value.intent.seq)
    assert.deepEqual(value.result.outcome.outputs, outputs, 'durable values must be exact, not stringified/coerced/shape-normalized')
    const projected = inspection.attempts.find(item => item.attemptId === value.attemptId)
    assert.ok(projected)
    assert.equal(projected.errorCode, undefined)
    assert.deepEqual(JSON.parse(projected.outputJson).outputs, outputs)
  }
}
async function rejected(h, record, nodeId, code) {
  assert.equal(record.state, 'failed')
  const value = attempt(record, nodeId)
  assert.equal(value.state, 'failed')
  assert.ok(value.intent)
  assert.ok(value.result)
  assert.equal(value.result.ok, false)
  assert.equal(value.result.outcome.kind, code)
  assert.ok(value.result.seq > value.intent.seq)
  const inspection = await h.service.inspectRun({ runId: record.runId })
  const projected = inspection.attempts.find(item => item.attemptId === value.attemptId)
  assert.ok(projected)
  assert.equal(projected.errorCode, code)
  assert.equal(projected.outputJson, undefined)
  return value
}

for (const [label, value] of values) {
  test(`C-06/C-08 nominal ${label}: same-name field passes exactly through saved admission and output`, async t => {
    const h = await fixture(t, passThrough())
    const started = await start(h, { payload: value, ignored: 'NOT_A_PORT' })
    await success(t, h, started, { source: { payload: value }, sink: { payload: value } })
  })
  test(`C-06/C-08 nominal ${label}: input port fallback retains the whole JSON value`, async t => {
    const h = await fixture(t, passThrough())
    const started = await start(h, value)
    await success(t, h, started, { source: { payload: value }, sink: { payload: value } })
  })
}
test('C-06 nominal output port fallback preserves the entire bound port map', async t => {
  const definition = passThrough()
  definition.graph.nodes[1].outputs = { whole: nominal }
  const h = await fixture(t, definition)
  const value = { exact: [null, false, 'PUBLIC_FIXTURE'] }
  const started = await start(h, { payload: value })
  await success(t, h, started, { source: { payload: value }, sink: { whole: { payload: value } } })
})
test('C-08 nominal saved revision, command replay and restart never redispatch or mutate durable outcomes', async t => {
  const h = await fixture(t, passThrough())
  const previous = await h.service.loadDefinition({ blueprintId: h.definition.id })
  const next = passThrough('Domain Payload/v2')
  next.name = 'Saved nominal revision'
  const saved = await h.service.saveDefinition({ blueprintId: next.id, expectedRevision: previous.documentRevision, definitionJson: json(next) })
  assert.notEqual(saved.documentRevision, previous.documentRevision)
  const started = await start(h, { payload: [false, null, { exact: 7 }] }, 'nominal-once')
  assert.equal(started.document.documentRevision, saved.documentRevision)
  const before = structuredClone(started.record)
  const inspectionBefore = await h.service.inspectRun({ runId: before.runId })
  const replay = await h.service.startRun(started.args)
  assert.equal(replay.replayed, true)
  assert.equal(replay.runId, before.runId)
  await h.handle.driverTail
  assert.deepEqual(await h.handle.store.get(before.runId), before)
  await h.reopen()
  assert.deepEqual(await h.handle.store.get(before.runId), before)
  assert.deepEqual(await h.service.inspectRun({ runId: before.runId }), inspectionBefore)
  const replayAfterRestart = await h.service.startRun(started.args)
  assert.equal(replayAfterRestart.replayed, true)
  assert.equal(replayAfterRestart.runId, before.runId)
  await h.handle.driverTail
  assert.deepEqual(await h.handle.store.get(before.runId), before)
  await success(t, h, started, { source: { payload: [false, null, { exact: 7 }] }, sink: { payload: [false, null, { exact: 7 }] } })
})
for (const predicate of [true, false]) {
  for (const [label, value] of values) {
    test(`C-06 nominal selected join ${predicate}/${label}: skipped sibling cannot contribute or omit the selected value`, async t => {
      const h = await fixture(t, selectedJoin())
      const started = await start(h, { predicate, payload: value })
      const selected = predicate ? 'yesPath' : 'noPath', skipped = predicate ? 'noPath' : 'yesPath'
      await success(t, h, started, { source: { predicate, payload: value }, [selected]: { payload: value }, merge: { payload: value }, sink: { payload: value } })
      assert.equal(attempt(started.record, 'choose').result.outcome.branch, predicate ? 'yes' : 'no')
      const notSelected = attempt(started.record, skipped)
      assert.equal(notSelected.state, 'skipped')
      assert.equal(notSelected.intent, undefined)
      assert.equal(notSelected.result, undefined)
      const before = structuredClone(started.record)
      await h.reopen()
      assert.deepEqual(await h.handle.store.get(before.runId), before, 'selected branch and nominal output survive restart without reinterpretation')
    })
  }
}
test('C-06 nominal selected parent missing output: durable binding-missing, never a successful merge', async t => {
  const definition = graph([
    { id: 'left', kind: 'input', outputs: { payload: nominal } },
    { id: 'right', kind: 'input', outputs: { payload: nominal } },
    { id: 'merge', kind: 'join', inputs: { payload: nominal }, outputs: { payload: nominal } },
  ], [{ kind: 'data', from: 'left.payload', to: 'merge.payload' }, { kind: 'data', from: 'right.payload', to: 'merge.payload' }])
  const h = await fixture(t, definition)
  const definitionJson = json(definition), inputJson = '{}'
  const report = await h.service.preflightRun({ blueprintId: definition.id,
    expectedRevision: (await h.service.loadDefinition({ blueprintId: definition.id })).documentRevision, inputJson })
  assert.equal(report.canStart, true)
  const { runId } = await h.handle.store.createRun({ scope: 'run', requestId: randomUUID(),
    payloadFingerprint: createHash('sha256').update(`${definitionJson}\0${inputJson}`).digest('hex') }, 'seed-missing-result', definitionJson, inputJson)
  const intent = await h.handle.store.recordIntent(runId, { nodeId: 'left', kind: 'input' })
  await h.handle.store.recordResult(runId, intent.attemptId, { ok: true, outcome: { outputs: {} }, evidence: 'fixture-selected-no-output' })
  await h.handle.store.transition(runId, draft => { draft.attempts.push({ attemptId: 'skipped-right', nodeId: 'right', attempt: 1, state: 'skipped' }) })
  const before = await h.handle.store.get(runId)
  assert.equal(attempt(before, 'left').state, 'succeeded')
  assert.equal(Object.hasOwn(attempt(before, 'left').result.outcome.outputs, 'payload'), false)
  assert.equal(attempt(before, 'right').result, undefined)
  await h.service.driveRun(h.handle, runId, definition)
  const record = await h.handle.store.get(runId)
  await rejected(h, record, 'merge', 'binding-missing')
  await h.reopen()
  assert.deepEqual(await h.handle.store.get(runId), record)
})
test('C-06 nominal missing input is not an undefined JSON value authorization', async t => {
  const h = await fixture(t, graph([{ id: 'source', kind: 'input', inputs: { payload: nominal }, outputs: { payload: nominal } }]))
  const { record } = await start(h, {})
  await rejected(h, record, 'source', 'input-missing')
})
for (const destination of ['OtherDomainPayload', 'domainpayload']) {
  test(`C-06/C-08 nominal unequal label ${destination}: definition validator rejects before admission`, async t => {
    const definition = passThrough()
    definition.graph.nodes[1].inputs.payload = destination
    assert.throws(() => validateDefinition(decodeDefinition(json(definition))), error =>
      error.code === 'DEFINITION_INVALID' && error.issues.some(issue => issue.code === 'port-mismatch' && issue.pointer === '/graph/edges/0/to'))
    const h = await fixture(t, passThrough())
    await assert.rejects(h.service.validate({ definitionJson: json(definition) }), error => error.code === 'blueprint/definition-invalid')
  })
}
test('C-06 missing or empty wire labels remain definition errors, not nominal authorization', () => {
  for (const invalid of ['', undefined]) {
    const definition = passThrough()
    definition.graph.nodes[0].outputs.payload = invalid
    assert.throws(() => validateDefinition(decodeDefinition(json(definition))), error => error.code === 'DEFINITION_INVALID')
  }
})
for (const [type, invalid] of [['string', 7], ['number', '7'], ['boolean', 'false']]) {
  for (const location of ['input', 'output']) {
    test(`C-06 builtin ${type} ${location}: nominal compatibility does not admit a mismatched primitive`, async t => {
      const node = { id: 'source', kind: 'input', ...(location === 'input' ? { inputs: { payload: type } } : {}), outputs: { payload: type } }
      const h = await fixture(t, graph([node]))
      const { record } = await start(h, { payload: invalid })
      await rejected(h, record, 'source', `${location}-invalid`)
    })
  }
}
for (const [type, value] of [['string', 'PUBLIC_FIXTURE'], ['number', 0], ['boolean', false], ['json', null], ['json', { nested: [false, null, 3] }]]) {
  test(`C-06 builtin ${type}/${value === null ? 'null' : typeof value}: valid exact values stay accepted`, async t => {
    const h = await fixture(t, passThrough(type))
    const started = await start(h, { payload: value })
    await success(t, h, started, { source: { payload: value }, sink: { payload: value } })
  })
}
for (const invalid of ['true', 1, null, {}, []]) {
  test(`C-05 condition ${json(invalid)}: opaque nominal labels do not relax the actual boolean predicate`, async t => {
    const definition = graph([
      { id: 'choose', kind: 'condition', inputs: { predicate: 'boolean' }, branches: ['yes', 'no'],
        condition: { inputPort: 'predicate', trueBranch: 'yes', falseBranch: 'no' } },
      { id: 'yesPath', kind: 'output' }, { id: 'noPath', kind: 'output' },
    ], [{ kind: 'control', from: 'choose@yes', to: 'yesPath' }, { kind: 'control', from: 'choose@no', to: 'noPath' }])
    const h = await fixture(t, definition)
    const { record } = await start(h, { predicate: invalid })
    await rejected(h, record, 'choose', 'condition-input-invalid')
    assert.equal(record.attempts.some(item => item.nodeId === 'yesPath' || item.nodeId === 'noPath'), false)
  })
}
test('C-08 malformed JSON never enters the nominal JSON envelope or admits a Run', async t => {
  const h = await fixture(t, passThrough())
  const document = await h.service.loadDefinition({ blueprintId: h.definition.id })
  const args = { blueprintId: document.blueprintId, expectedRevision: document.documentRevision, inputJson: '{"payload":undefined}', requestId: 'bad-json' }
  await assert.rejects(h.service.preflightRun({ blueprintId: args.blueprintId, expectedRevision: args.expectedRevision, inputJson: args.inputJson }), error => error.code === 'blueprint/definition-invalid')
  await assert.rejects(h.service.startRun(args), error => error.code === 'blueprint/definition-invalid')
})
