/** W1.1 Sol A: source service/admission contracts, NOT built/lib or live evidence.
 * Missing preflight has an explicit feature assertion, never a TypeError/import
 * failure. Existing startRun independently exercises the real admission path. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { harness, definition, agentNode, bindingResources, agentResources, SCHEMA, runArgs, runSaved, records, drain, executeTool } from './agent-fixtures.mjs'

const configuredBindings = { reader: { tools: ['read_allowed'] }, writer: { tools: ['write_other'] } }

async function expectBlocked(h, value, message) {
  const doc = await h.save(value)
  let failure
  try {
    await h.service.startRun(runArgs(doc))
  } catch (error) {
    failure = error
  }
  await drain(h)
  assert.equal(failure?.code, 'blueprint/preflight-blocked', message)
  assert.equal((await records(h)).length, 0, 'C-01: blocked admission creates no durable Run')
  assert.equal(h.host.calls.length, 0, 'C-01: blocked admission publishes no Agent')
  assert.deepEqual(h.effects, [], 'C-01: blocked admission dispatches no business tool')
}

for (const kind of ['toolCall', 'scriptCall']) {
  test(`C-01 definition hard break: ${kind} is rejected before admission`, () => {
    assert.throws(
      () => definition([{ id: 'unsupported', kind }], {}),
      error => error.code === 'DEFINITION_INVALID' && error.issues.some(issue => issue.pointer === '/graph/nodes/0/kind')
    )
  })
}

test('C-01 startRun: missing declared Host tool binding blocks before Agent creation', async t => {
  const h = await harness(t)
  await expectBlocked(
    h,
    definition([agentNode({ toolsetRefs: ['readset'] })], bindingResources),
    'C-01: declared reader binding is absent, but current startRun admits it'
  )
})

test('C-01 startRun: binding names must exist in the current real Tools view', async t => {
  const h = await harness(t, { config: { toolBindings: { reader: { tools: ['not_registered'] } } } })
  await expectBlocked(
    h,
    definition([agentNode({ toolsetRefs: ['readset'] })], bindingResources),
    'C-01: configured unknown tool cannot silently expand/fallback to Host capabilities'
  )
})

test('C-01 startRun: a configured binding cannot use a wildcard capability', async t => {
  const h = await harness(t, { config: { toolBindings: { reader: { tools: ['*'] } } } })
  await expectBlocked(h, definition([agentNode({ toolsetRefs: ['readset'] })], bindingResources), 'C-01: wildcard is not an exact registered capability name')
})

test('C-01 startRun: absent public Agent factory is an admission blocker', async t => {
  const h = await harness(t, { factory: false })
  await expectBlocked(h, definition(), 'C-01: missing public Agent composition is currently discovered only after admission')
})

test('C-01 startRun: absent Tools service is an admission blocker, not unrestricted fallback', async t => {
  const h = await harness(t, { tools: false })
  await expectBlocked(h, definition(), 'C-01: no Tools service cannot mean all Host tools are permitted')
})

test('C-01 preflightRun: layered report is read-only and resource/MCP readiness is not authorization', async t => {
  const h = await harness(t, { config: { toolBindings: configuredBindings } })
  const doc = await h.save(definition([agentNode({ toolsetRefs: ['readset'] })], bindingResources))
  assert.equal(typeof h.service.preflightRun, 'function', 'C-01 capability oracle: existing service has no preflightRun')
  const report = await h.service.preflightRun({
    blueprintId: doc.blueprintId,
    expectedRevision: doc.documentRevision,
    inputJson: JSON.stringify({ task: 'PREFLIGHT_INPUT_SECRET_SENTINEL' })
  })
  assert.equal(report.blueprintId, doc.blueprintId)
  assert.equal(report.documentRevision, doc.documentRevision)
  assert.equal(report.semanticRevision, doc.semanticRevision)
  assert.equal(report.canStart, true)
  assert.ok(report.checks.length > 0, 'C-01: nonempty layered evidence, not a bare boolean')
  for (const check of report.checks) {
    assert.ok(['block', 'warning', 'info', 'pass'].includes(check.status))
    assert.equal(typeof check.code, 'string')
    assert.ok(check.code.length > 0)
    assert.ok(
      Object.keys(check).every(key => ['code', 'status', 'nodeId', 'resourceId', 'toolName'].includes(key)),
      'C-01: report uses the stable-code/logical-ID whitelist'
    )
  }
  assert.ok(
    report.checks.some(check => check.code === 'reachability-unverified'),
    'C-01: registered MCP capability is not evidence of reachable remote service'
  )
  assert.equal(h.host.calls.length, 0)
  assert.deepEqual(h.effects, [])
  assert.equal((await records(h)).length, 0)
  assert.ok(!JSON.stringify(report).includes(h.root))
  assert.ok(!JSON.stringify(report).includes('PREFLIGHT_INPUT_SECRET_SENTINEL'))
})

test('C-01 startRun: Host capability change after green preflight is rechecked on new admission', async t => {
  const h = await harness(t, { config: { toolBindings: configuredBindings } })
  const doc = await h.save(definition([agentNode({ toolsetRefs: ['readset'] })], bindingResources))
  assert.equal(typeof h.service.preflightRun, 'function', 'C-01 capability oracle: preflightRun must exist before a stale-report test')
  const args = runArgs(doc)
  const report = await h.service.preflightRun({ blueprintId: args.blueprintId, expectedRevision: args.expectedRevision, inputJson: args.inputJson })
  assert.equal(report.canStart, true)
  // Real registration removal, not a stubbed preflight result or allowlist function.
  const remove = h.nativeTools.register({
    name: 'temporary_binding',
    description: 'temporary capability',
    parameters: { type: 'object' },
    output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'ok' }] },
    execute: async () => true
  })
  remove()
  // Mutate the Host-owned binding object; preflight is not an authority token.
  configuredBindings.reader.tools = ['temporary_binding']
  t.after(() => {
    configuredBindings.reader.tools = ['read_allowed']
  })
  await assert.rejects(h.service.startRun(args), error => error.code === 'blueprint/preflight-blocked')
  assert.equal(h.host.calls.length, 0)
  assert.deepEqual(h.effects, [])
})

for (const [label, schema] of [
  ['external-ref', { ...SCHEMA, $ref: 'https://example.invalid/schema' }],
  ['unsupported-keyword', { ...SCHEMA, allOf: [{ type: 'object' }] }]
]) {
  test(`C-01/C-03 startRun: ${label} schema is rejected before dispatch`, async t => {
    const h = await harness(t)
    writeFileSync(join(h.rootDir, 'lib/schemas/answer.json'), JSON.stringify(schema))
    const value = definition([agentNode({ outputSchemaRef: 'answerSchema' })], {
      ...agentResources,
      answerSchema: { kind: 'schema', path: 'lib/schemas/answer.json' }
    })
    await expectBlocked(h, value, 'C-03: schema bytes must be validated with the public DSH subset before new admission')
  })
}

test('C-08 control: schemaVersion=2 plain AgentTask completes and preserves explicit output', async t => {
  const h = await harness(t)
  const { record } = await runSaved(h, definition([agentNode({ outputs: { answer: 'string' } })]))
  assert.equal(record.state, 'succeeded')
  assert.equal(h.host.calls.length, 1)
  assert.equal(record.attempts[0].result.outcome.outputs.answer, 'LEGACY_EXPLICIT_OUTPUT')
  assert.deepEqual(h.effects, [])
})

test('C-08 control: malformed input and stale document revision remain typed and side-effect free', async t => {
  const h = await harness(t)
  const doc = await h.save(definition())
  await assert.rejects(h.service.startRun({ ...runArgs(doc), inputJson: '{' }), error => error.code === 'blueprint/definition-invalid')
  await assert.rejects(h.service.startRun({ ...runArgs(doc), expectedRevision: 'stale' }), error => error.code === 'blueprint/revision-conflict')
  assert.equal(h.host.calls.length, 0)
  assert.equal((await records(h)).length, 0)
})

test('C-08 control: command replay survives changed Host capability without redispatch or refreezing', async t => {
  const h = await harness(t, {
    config: { toolBindings: { reader: { tools: ['read_allowed'] } } },
    onTurn: async call => {
      call.result = await executeTool(call, 'read_allowed')
      call.finish()
    }
  })
  const value = definition([agentNode({ toolsetRefs: ['readset'] })], bindingResources)
  const { args, admitted, record } = await runSaved(h, value)
  assert.equal(h.host.calls.length, 1)
  const frozen = JSON.stringify(record)
  // Global monotonic denial is a real Host policy change after durable success.
  const deny = h.nativeTools.guard(() => 'HOST_CAPABILITY_CHANGED')
  t.after(deny)
  const replay = await h.service.startRun(args)
  await drain(h)
  assert.equal(replay.replayed, true)
  assert.equal(replay.runId, admitted.runId)
  assert.equal(h.host.calls.length, 1, 'C-08: replay cannot create another public Agent')
  assert.equal(JSON.stringify((await records(h)).find(run => run.runId === admitted.runId)), frozen)
  assert.deepEqual(h.effects, ['read_allowed'])
})
