/** W1.1 Sol A: real Blueprint AgentExecutor/driver + DSH Tools/Session.
 * No missing structured import, internal DSH src, fake parent, policy emulation,
 * skip or sleep. Proposed W2 internal spec seam: effectiveToolNames. Actual
 * toolsetRefs/binding/allowlist wiring is separately tested via public service. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { BlueprintService } from '../../src/index.ts'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'
import {
  harness,
  definition,
  agentNode,
  bindingResources,
  directSpec,
  executeTool,
  drain,
  runSaved,
  records,
  SCHEMA,
  MODEL,
  AGENT_BYTES,
  contentTool,
  sha256,
  structuredDefinition
} from './agent-fixtures.mjs'

const bindings = { reader: { tools: ['read_allowed'] }, writer: { tools: ['write_other'] } }
const work = record => record.attempts.find(attempt => attempt.nodeId === 'work')
const noSink = record => assert.ok(!record.attempts.some(attempt => attempt.nodeId === 'sink'), 'C-03: unaccepted output must not dispatch the downstream node')
function assertDenial(result, message) {
  assert.equal(result.isError, true, message)
  // Public ToolFailure is { message, info?: { name, code } }, not error.code.
  // A Host monotonic guard supplies a reason only; no fabricated typed identity.
  assert.equal(typeof result.error?.message, 'string', 'C-02: canonical denial retains failure detail')
  assert.ok(result.error.message.length > 0)
  assert.equal(result.value, undefined, 'C-02: denied calls cannot carry a successful value')
}

test('C-02 undeclared business tools: real public setup explicitly denies inherited capabilities', async t => {
  const h = await harness(t, {
    onTurn: async call => {
      call.visible = call.agent.ctx.tools.schemas(call.agent).map(tool => tool.name)
      call.result = await executeTool(call, 'read_allowed')
      call.finish()
    }
  })
  const evidence = await h.executor().execute(directSpec(h))
  assert.equal(evidence.outcome.kind, 'succeeded', 'control: public terminal turn settled')
  assert.equal(h.host.calls.length, 1, 'control: executor published one Agent after setup')
  assertDenial(h.host.calls[0].result, 'C-02: omitted toolsetRefs currently leave read_allowed executable')
  assert.deepEqual(h.effects, [])
  assert.ok(!h.host.calls[0].visible.includes('read_allowed'))
  assert.ok(h.nativeTools.get('read_allowed'), 'C-02: setup must not restrict global Host view')
})

test('C-02 declared binding: production driver passes exact binding union to real scoped setup', async t => {
  const h = await harness(t, {
    config: { toolBindings: bindings },
    onTurn: async call => {
      call.allowed = await executeTool(call, 'read_allowed')
      call.other = await executeTool(call, 'write_other')
      call.visible = call.agent.ctx.tools.schemas(call.agent).map(tool => tool.name)
      call.finish()
    }
  })
  const { record } = await runSaved(h, definition([agentNode({ toolsetRefs: ['readset'] })], bindingResources))
  assert.equal(record.state, 'succeeded')
  assert.equal(h.host.calls[0].allowed.isError, false, 'control: declared/registered tool remains usable')
  assertDenial(h.host.calls[0].other, 'C-02: write_other currently runs outside declared reader binding')
  assert.deepEqual(h.effects, ['read_allowed'])
  assert.deepEqual(h.host.calls[0].visible.sort(), ['read_allowed'])
})

test('C-02 optional node allowlist: strict public definition accepts narrowing and driver enforces it', async t => {
  const h = await harness(t, {
    config: { toolBindings: bindings },
    onTurn: async call => {
      call.allowed = await executeTool(call, 'read_allowed')
      call.other = await executeTool(call, 'write_other')
      call.finish()
    }
  })
  const value = definition([agentNode({ toolsetRefs: ['readset', 'writeset'] })], bindingResources)
  value.graph.nodes[0].toolAllowlist = ['read_allowed']
  let saved, failure
  try {
    saved = await h.save(value)
  } catch (error) {
    failure = error
  }
  // Explicit feature oracle: old strict codec rejection of the new field is
  // the contract gap, never an accidental malformed fixture/import failure.
  assert.equal(failure?.code, undefined, 'C-02 definition capability oracle: current strict decoder rejects target toolAllowlist as unknown-field')
  assert.ok(saved)
  const admitted = await h.service.startRun({
    blueprintId: saved.blueprintId,
    expectedRevision: saved.documentRevision,
    inputJson: '{}',
    requestId: 'allowlist-contract'
  })
  await drain(h)
  assert.equal((await records(h)).find(run => run.runId === admitted.runId).state, 'succeeded')
  assert.equal(h.host.calls[0].allowed.isError, false)
  assertDenial(h.host.calls[0].other, 'C-02: binding union must be narrowed by node allowlist')
  assert.deepEqual(h.effects, ['read_allowed'])
})

test('C-02 scoped-local guard: setup masks cannot be bypassed by local registration or later allow listener', async t => {
  let localBodies = 0
  const h = await harness(t, {
    config: { toolBindings: bindings },
    onTurn: async call => {
      call.agent.ctx.tools.register(
        contentTool('scope_escape', () => {
          localBodies++
        })
      )
      call.agent.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), true)
      call.local = await executeTool(call, 'scope_escape', { secret: 'TOOL_ARGUMENT_SECRET_SENTINEL' })
      call.finish()
    }
  })
  await runSaved(h, definition([agentNode({ toolsetRefs: ['readset'] })], bindingResources))
  assertDenial(h.host.calls[0].local, 'C-02: real scoped registration is currently executable outside effective names')
  assert.equal(localBodies, 0, 'C-02: monotonic post-policy guard prevents the body')
  assert.ok(!h.nativeTools.get('scope_escape'), 'control: scope-local registration never became global')
})

test('C-02 control: Host monotonic deny and absent approval support cannot be bypassed by blueprint setup', async t => {
  const h = await harness(t, {
    config: { toolBindings: { reader: { tools: ['host_denied', 'read_allowed'] } } },
    onTurn: async call => {
      call.denied = await executeTool(call, 'host_denied')
      call.ask = await executeTool(call, 'read_allowed')
      call.finish()
    }
  })
  const removeDeny = h.nativeTools.guard(exec => (exec.name === 'host_denied' ? 'HOST_DENY_STATIC_CODE' : undefined))
  const removeAsk = h.ctx.on('tools/pre-execute', async exec =>
    exec.name === 'read_allowed' ? { kind: 'ask', reason: 'HOST_APPROVAL_REQUIRED' } : { kind: 'allow' }
  )
  t.after(removeDeny)
  t.after(removeAsk)
  await runSaved(h, definition([agentNode({ toolsetRefs: ['readset'] })], bindingResources))
  assertDenial(h.host.calls[0].denied, 'control: no force allow over Host deny')
  assertDenial(h.host.calls[0].ask, 'control: missing approval service degrades to denial')
  assert.equal(h.host.calls[0].denied.error.message, 'HOST_DENY_STATIC_CODE')
  assert.equal(h.host.calls[0].ask.error.message, 'HOST_APPROVAL_REQUIRED')
  assert.deepEqual(h.effects, [])
})

test('C-02 two concurrent Agent scopes: reader/writer restrictions are isolated and dispose without global residue', async t => {
  const bothStarted = Promise.withResolvers()
  const observations = []
  const h = await harness(t, {
    onTurn: async call => {
      observations.push(call)
      if (observations.length === 2) bothStarted.resolve()
      await bothStarted.promise
      call.read = await executeTool(call, 'read_allowed')
      call.write = await executeTool(call, 'write_other')
      call.finish()
    }
  })
  await Promise.all([
    h.executor().execute(directSpec(h, { nodeId: 'reader', effectiveToolNames: ['read_allowed'] })),
    h.executor().execute(directSpec(h, { nodeId: 'writer', effectiveToolNames: ['write_other'] }))
  ])
  assert.equal(h.host.calls.length, 2)
  assert.equal(h.host.calls[0].read.isError, false)
  assert.equal(h.host.calls[1].write.isError, false)
  assertDenial(h.host.calls[0].write, 'C-02: reader scope currently executes writer capability')
  assertDenial(h.host.calls[1].read, 'C-02: writer scope cannot inherit another Attempt grant')
  assert.ok(h.host.calls.every(call => call.disposed))
  assert.ok(h.nativeTools.get('read_allowed') && h.nativeTools.get('write_other'))
})

test('C-02 setup rollback: missing actual Tools service must not publish an unrestricted Agent', async t => {
  const h = await harness(t, { tools: false })
  let error, evidence
  try {
    evidence = await h.executor().execute(directSpec(h))
  } catch (caught) {
    error = caught
  }
  assert.equal(h.host.calls.length, 0, 'C-02: existing setup publishes an Agent without required Tools service')
  assert.ok(error?.code || evidence?.outcome.ok === false, 'C-02: setup fails typed before followup')
})

test('C-02 PTC transport: run_code may transport only effective terminal tool bindings', async t => {
  let sdkNames, nestedResults
  const h = await harness(t, {
    mode: 'both',
    config: { toolBindings: bindings },
    ptcRun: async request => {
      const functions = request.bindings.find(binding => binding.global === 'tools').functions
      sdkNames = Object.keys(functions).sort()
      const read = await functions.read_allowed({})
      const write = functions.write_other ? await functions.write_other({}) : undefined
      nestedResults = { read, write }
      return { logs: [], value: 'transport completed' }
    },
    onTurn: async call => {
      call.transport = await executeTool(call, 'run_code', { description: 'policy contract', code: 'return await tools.read_allowed({})' })
      call.finish()
    }
  })
  await runSaved(h, definition([agentNode({ toolsetRefs: ['readset'] })], bindingResources))
  assert.equal(h.host.calls[0].transport.isError, false, 'control: run_code is transport, not a business-tool wildcard')
  assert.deepEqual(sdkNames, ['read_allowed'], 'C-02: actual PTC SDK currently exposes undeclared terminal capabilities')
  assert.deepEqual(nestedResults.read, { ok: true })
  assert.equal(nestedResults.write, undefined)
  assert.deepEqual(h.effects, ['read_allowed'])
})

test('C-03 control: public DSH schema validator supports object root and rejects unknown/network keywords', () => {
  assert.doesNotThrow(() => assertObjectJsonSchema(SCHEMA))
  assert.deepEqual(validateJsonSchemaValue(SCHEMA, { answer: 42 }), [])
  assert.ok(validateJsonSchemaValue(SCHEMA, { answer: 'invalid' }).length > 0)
  assert.throws(() => assertObjectJsonSchema({ ...SCHEMA, $ref: 'https://example.invalid/schema' }))
  assert.throws(() => assertObjectJsonSchema({ ...SCHEMA, allOf: [] }))
  assert.throws(() => assertObjectJsonSchema({ type: 'array' }))
})

test('C-03 frozen schema + authoritative native tool: committed object, not contradictory completion text, feeds ports', async t => {
  let seenSchema
  const h = await harness(t, {
    onTurn: async call => {
      writeFileSync(join(h.rootDir, 'lib/schemas/answer.json'), JSON.stringify({ ...SCHEMA, required: ['changed'] }))
      seenSchema = call.agent.ctx.tools.get('structured_output', call.agent)?.parameters
      call.captured = await executeTool(call, 'structured_output', { answer: 42 })
      call.finish(undefined, '{"answer":-999}')
    }
  })
  const { record } = await runSaved(h, structuredDefinition())
  assert.equal(record.state, 'succeeded', 'C-03: current driver refuses outputSchemaRef rather than running capture')
  assert.deepEqual(seenSchema, SCHEMA, 'C-03: schema came from Run-frozen bytes')
  assert.equal(h.host.calls[0].captured.isError, false)
  assert.deepEqual(work(record).result.outcome.outputs, { object: { answer: 42 }, text: '{"answer":42}' })
  assert.equal(record.attempts.find(attempt => attempt.nodeId === 'sink').state, 'succeeded')
  assert.ok(!h.nativeTools.get('structured_output'), 'C-03: capture is Attempt-local, not global')
})

test('C-03 missing capture: terminal completed text is typed structured-output-missing and never dispatches downstream', async t => {
  const h = await harness(t, { onTurn: call => call.finish(undefined, '{"answer":42}') })
  const { record } = await runSaved(h, structuredDefinition())
  assert.equal(
    work(record).result.outcome.kind,
    'structured-output-missing',
    'C-03: current driver reports generic failed/unsupported, not typed missing capture'
  )
  assert.equal(work(record).result.ok, false)
  assert.equal(h.host.calls.length, 1, 'C-03: acceptance evaluates actual completed Agent')
  noSink(record)
})

test('C-03 invalid capture: DSH schema violations settle typed output-invalid without raw values or downstream dispatch', async t => {
  const h = await harness(t, {
    onTurn: async call => {
      call.invalid = await executeTool(call, 'structured_output', { answer: 'INVALID_VALUE_SECRET_SENTINEL' })
      call.finish(undefined, 'not accepted')
    }
  })
  const { record } = await runSaved(h, structuredDefinition())
  assert.equal(work(record).result.outcome.kind, 'output-invalid', 'C-03: invalid differs from missing/provider/unsupported')
  assert.equal(work(record).result.ok, false)
  assert.equal(h.host.calls[0].invalid.isError, true)
  assert.ok(work(record).diagnostics.acceptance.issueCount > 0)
  assert.ok(!JSON.stringify(work(record).result).includes('INVALID_VALUE_SECRET_SENTINEL'))
  noSink(record)
})

test('C-03 post-result rejection: tool body success cannot commit before authoritative tools/result', async t => {
  const h = await harness(t, {
    onTurn: async call => {
      call.result = await executeTool(call, 'structured_output', { answer: 42 })
      call.finish()
    }
  })
  const remove = h.ctx.on('tools/post-execute', async exec =>
    exec.name === 'structured_output' ? { kind: 'block', feedback: [{ type: 'text', text: 'CONTROLLED_POST_POLICY_DENY' }] } : { kind: 'accept' }
  )
  t.after(remove)
  const { record } = await runSaved(h, structuredDefinition())
  assert.equal(work(record).result.outcome.kind, 'structured-output-missing', 'C-03: post-policy block cannot count as capture')
  assert.equal(h.host.calls[0].result.isError, true)
  noSink(record)
})

for (const denyParent of [false, true]) {
  test(`C-03 PTC parent ${denyParent ? 'denied' : 'committed'}: nested structured result waits for authoritative transport outcome`, async t => {
    let nestedCommitted = false
    const h = await harness(t, {
      mode: 'both',
      ptcRun: async request => {
        const functions = request.bindings.find(binding => binding.global === 'tools').functions
        // Actual DSH SDK subdispatch preserves exec.parent/token. No mock capture.
        if (functions.structured_output) {
          await functions.structured_output({ answer: 42 })
          nestedCommitted = true
        }
        return { logs: [], value: 'nested submitted' }
      },
      onTurn: async call => {
        call.transport = await executeTool(call, 'run_code', {
          description: 'structured commit contract',
          code: 'return await tools.structured_output({answer:42})'
        })
        call.finish()
      }
    })
    const finalNotifications = []
    h.ctx.on('tools/result', (exec, result) => {
      finalNotifications.push({ name: exec.name, token: exec.token, parent: exec.parent, isError: result.isError })
    })
    if (denyParent) {
      const remove = h.ctx.on('tools/post-execute', async exec =>
        exec.name === 'run_code' ? { kind: 'block', feedback: [{ type: 'text', text: 'PTC_PARENT_NOT_ACCEPTED' }] } : { kind: 'accept' }
      )
      t.after(remove)
    }
    const { record } = await runSaved(h, structuredDefinition())
    if (denyParent) {
      assert.equal(work(record).result.outcome.kind, 'structured-output-missing', 'C-03: successful nested body is not parent commit')
      noSink(record)
    } else {
      assert.equal(record.state, 'succeeded', 'C-03: committed PTC capture must satisfy output schema')
      assert.deepEqual(work(record).result.outcome.outputs.object, { answer: 42 })
    }
    assert.equal(nestedCommitted, true, 'C-03: nested structured dispatch really ran')
    const child = finalNotifications.find(event => event.name === 'structured_output')
    const parent = finalNotifications.find(event => event.name === 'run_code')
    assert.equal(child.isError, false)
    assert.equal(child.parent, parent.token, 'C-03: opaque parent correlation, not guessed callId')
    assert.equal(parent.isError, denyParent)
  })
}

test('C-03 control: idle without terminal turn/end never means succeeded', async t => {
  const h = await harness(t, { onTurn: call => call.quiesceWithoutEnd() })
  const evidence = await h.executor().execute(directSpec(h))
  assert.equal(evidence.outcome.ok, false)
  assert.equal(evidence.outcome.kind, 'recovery_required')
  assert.ok(!h.host.calls[0].session.snapshotEvents().some(event => event.type === 'turn/end'))
})

test('C-04 diagnostics: durable input digests, resources, actual model/options and effective tools use a strict whitelist', async t => {
  const input = { task: 'INPUT_SECRET_SENTINEL', nested: { token: 'RAW_SECRET_SENTINEL' } }
  const h = await harness(t, { config: { toolBindings: bindings } })
  const { record } = await runSaved(h, definition([agentNode({ toolsetRefs: ['readset'] })], bindingResources), input)
  const inspected = await h.service.inspectRun({ runId: record.runId })
  const durable = work(record).diagnostics
  assert.ok(durable, 'C-04 capability oracle: actual durable Attempt currently has no diagnostics')
  assert.deepEqual(inspected.attempts[0].diagnostics, durable, 'C-04: inspectRun projects durable facts, not Host guess')
  assert.ok(
    Object.keys(durable).every(key => ['status', 'input', 'resourceDigests', 'modelSelection', 'tools', 'acceptance', 'recovery'].includes(key)),
    'C-04: no raw spec/prompt/body copied into diagnostics'
  )
  assert.deepEqual(durable.input, { type: 'object', bytes: Buffer.byteLength(JSON.stringify(input)), sha256: sha256(JSON.stringify(input)) })
  assert.deepEqual(durable.resourceDigests, work(record).intent.resourceDigests)
  assert.equal(durable.resourceDigests.worker, sha256(AGENT_BYTES))
  assert.deepEqual(durable.modelSelection, MODEL)
  assert.deepEqual(h.host.calls[0].options.agentOptions, durable.modelSelection)
  assert.deepEqual(durable.tools.effectiveNames, ['read_allowed'])
  assert.equal(durable.acceptance.code, 'not-required')
  const safe = JSON.stringify(durable)
  for (const forbidden of [h.root, AGENT_BYTES, 'INPUT_SECRET_SENTINEL', 'RAW_SECRET_SENTINEL']) {
    assert.ok(!safe.includes(forbidden), 'C-04: approved summaries only')
  }
  await h.close()
  assert.deepEqual(work((await records(h))[0]).diagnostics, durable, 'C-04: JSON reopen preserves diagnostics')
  const ctx = new Context()
  const fiber = await ctx.plugin(BlueprintService, { runtimeRoot: h.runtimeRoot })
  try {
    const afterRestart = await ctx.blueprint.inspectRun({ runId: record.runId })
    assert.deepEqual(afterRestart.attempts[0].diagnostics, durable)
  } finally {
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
})

test('C-04/C-08 old durable Run: inspectRun marks diagnostics unavailable without manufacturing model/tool facts', async t => {
  const h = await harness(t)
  const opened = await openBlueprintDomain({ backend: 'json', path: join(h.runtimeRoot, 'store') })
  let runId
  try {
    const store = new RunStore(opened.domain)
    const created = await store.createRun(
      { scope: 'run', requestId: 'legacy-diagnostics', payloadFingerprint: sha256('old') },
      'legacy-revision',
      JSON.stringify(definition()),
      '{}'
    )
    runId = created.runId
    const intent = await store.recordIntent(runId, { nodeId: 'work', kind: 'agentTask' })
    await store.recordResult(runId, intent.attemptId, { ok: true, outcome: { kind: 'succeeded', outputs: { answer: 'LEGACY_OUTPUT' } }, evidence: 'legacy' })
    await store.settleTerminal(runId, 'succeeded', { reason: 'legacy-terminal' })
  } finally {
    await opened.close()
  }
  const view = await h.service.inspectRun({ runId })
  assert.equal(view.state, 'succeeded', 'control: old durable shape remains readable')
  assert.equal(view.attempts[0].outputJson, '{"outputs":{"answer":"LEGACY_OUTPUT"}}', 'C-08: explicit old output remains intact')
  assert.deepEqual(view.attempts[0].diagnostics, { status: 'unavailable' }, 'C-04: current Host defaults are not old Run evidence')
  assert.equal(h.host.calls.length, 0)
})
