/** W2 A additions requested by the main reviewer. Real public Tools and scope
 * reach production preflight -> startRun -> driver -> executor setup. No policy
 * stub, alternate driver, provider/network call or timing-based success oracle. */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  harness, definition, agentNode, bindingResources, contentTool, executeTool,
  runSaved, records, drain, sha256, MODEL,
} from './agent-fixtures.mjs'

const bindings = { reader: { tools: ['read_allowed'] } }

test('C-02 allowlist intersection: names outside the declared union never expand the real Agent scope', async t => {
  const h = await harness(t, { config: { toolBindings: bindings }, onTurn: async call => {
    call.allowed = await executeTool(call, 'read_allowed')
    call.outside = await executeTool(call, 'write_other')
    call.visible = call.agent.ctx.tools.schemas(call.agent).map(tool => tool.name)
    call.finish()
  } })
  const value = definition([agentNode({ toolsetRefs: ['readset'],
    toolAllowlist: ['read_allowed', 'write_other', 'undeclared_absent'] })], bindingResources)
  const { record } = await runSaved(h, value)
  assert.equal(record.state, 'succeeded', 'outside allowlist names narrow by intersection, not whole-Run rejection')
  assert.equal(h.host.calls.length, 1)
  assert.equal(h.host.calls[0].allowed.isError, false)
  assert.equal(h.host.calls[0].outside.isError, true)
  assert.deepEqual(h.effects, ['read_allowed'])
  assert.deepEqual(h.host.calls[0].visible, ['read_allowed'])
  assert.deepEqual(record.attempts[0].diagnostics.tools.effectiveNames, ['read_allowed'])
})

test('C-02 allowlist disjoint intersection: registered outsiders yield empty permission without blocking admission', async t => {
  const h = await harness(t, { config: { toolBindings: bindings }, onTurn: async call => {
    call.declared = await executeTool(call, 'read_allowed')
    call.outside = await executeTool(call, 'write_other')
    call.visible = call.agent.ctx.tools.schemas(call.agent).map(tool => tool.name)
    call.finish()
  } })
  const { record } = await runSaved(h, definition([agentNode({ toolsetRefs: ['readset'], toolAllowlist: ['write_other'] })], bindingResources))
  assert.equal(record.state, 'succeeded')
  assert.equal(h.host.calls[0].declared.isError, true)
  assert.equal(h.host.calls[0].outside.isError, true)
  assert.deepEqual(h.host.calls[0].visible, [])
  assert.deepEqual(h.effects, [])
  assert.deepEqual(record.attempts[0].diagnostics.tools.effectiveNames, [])
})

test('C-02 exact registered tool names: non-ASCII slash and leading digits survive real preflight and scoped execution', async t => {
  const name = '9读取/awkward-tool'
  let effects = 0
  const h = await harness(t, { config: { toolBindings: { reader: { tools: [name] } } }, onTurn: async call => {
    call.result = await executeTool(call, name)
    call.outside = await executeTool(call, 'read_allowed')
    call.visible = call.agent.ctx.tools.schemas(call.agent).map(tool => tool.name)
    call.finish()
  } })
  const remove = h.nativeTools.register(contentTool(name, () => { effects++ }))
  t.after(remove)
  assert.ok(h.nativeTools.get(name), 'fixture control: public Tools accepts this exact spelling')
  const { record } = await runSaved(h, definition([agentNode({ toolsetRefs: ['readset'], toolAllowlist: [name] })], bindingResources))
  assert.equal(record.state, 'succeeded')
  assert.equal(h.host.calls[0].result.isError, false)
  assert.equal(h.host.calls[0].outside.isError, true)
  assert.equal(effects, 1)
  assert.deepEqual(h.effects, [])
  assert.deepEqual(h.host.calls[0].visible, [name])
  assert.deepEqual(record.attempts[0].diagnostics.tools.effectiveNames, [name])
})

test('C-01/C-08 createAgent compatibility: readiness matches the retained public factory fallback and real scoped setup', async t => {
  const h = await harness(t, { onTurn: call => {
    call.visible = call.agent.ctx.tools.schemas(call.agent).map(tool => tool.name)
    call.finish()
  } })
  const create = h.host.registry.create
  let factoryOwner
  delete h.host.registry.create
  h.host.registry.createAgent = async (owner, options) => { factoryOwner = owner; return await create(options) }
  const doc = await h.save(definition())
  const args = { blueprintId: doc.blueprintId, expectedRevision: doc.documentRevision, inputJson: '{}', requestId: 'create-agent-fallback' }
  const report = await h.service.preflightRun(argsWithoutRequest(args))
  assert.equal(report.canStart, true)
  assert.ok(report.checks.some(check => check.code === 'agent-factory-ready' && check.status === 'pass'))
  assert.equal(h.host.calls.length, 0, 'preflight does not compose an Agent')
  const admitted = await h.service.startRun(args)
  await drain(h)
  assert.equal((await records(h)).find(run => run.runId === admitted.runId).state, 'succeeded')
  assert.equal(h.host.calls.length, 1)
  assert.ok(factoryOwner?.get('tools'), 'compatibility factory receives a real service owner Context')
  assert.deepEqual(h.host.calls[0].visible, [], 'omitted grants still mean empty business permission')
})

function argsWithoutRequest({ requestId: _requestId, ...args }) { return args }

for (const [type, value] of [
  ['string', 'STRING_RAW_SECRET_SENTINEL\n"escaped"'],
  ['null', null],
  ['array', ['ARRAY_RAW_SECRET_SENTINEL', null, { nested: true }]],
]) {
  test(`C-04 canonical ${type} input: durable bytes/hash describe typed JSON independently of Agent followup and the model is captured once before intent`, async t => {
    const encoded = JSON.stringify(value)
    const h = await harness(t, { onTurn: async call => {
      const event = call.session.snapshotEvents().findLast(event => event.type === 'user/message')
      assert.ok(event, 'fixture: dispatch uses the public user/message surface')
      call.dispatchedText = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      const before = (await records(h))[0]
      call.beforeEffect = before.attempts[0]
      call.finish()
    } })
    let selectionReads = 0
    t.mock.method(h.ctx.get('agentDefaultModel'), 'currentSelection', () => {
      selectionReads++
      return structuredClone(MODEL)
    })
    const { record } = await runSaved(h, definition(), value)
    const call = h.host.calls[0]
    const expected = { type, bytes: Buffer.byteLength(encoded), sha256: sha256(encoded) }
    assert.equal(record.state, 'succeeded')
    assert.equal(h.host.calls.length, 1)
    assert.equal(call.dispatchedText, type === 'string' ? value : encoded, type === 'string' ? 'the executor receives the logical string verbatim without JSON quoting' : 'the executor receives canonical JSON, including quoted strings')
    assert.deepEqual(call.beforeEffect.diagnostics.input, expected)
    assert.equal(call.beforeEffect.diagnostics.acceptance.code, 'pending', 'intent precedes the external completion')
    assert.equal(call.beforeEffect.result, undefined)
    assert.deepEqual(record.attempts[0].diagnostics.input, expected)
    assert.equal(record.attempts[0].diagnostics.acceptance.code, 'not-required')
    assert.equal(selectionReads, 1, 'executor must not reread the Host default after driver capture')
    assert.deepEqual(call.options.agentOptions, call.beforeEffect.diagnostics.modelSelection)
    const safe = JSON.stringify(record.attempts[0].diagnostics)
    assert.ok(!safe.includes(h.root))
    assert.ok(!safe.includes('RAW_SECRET_SENTINEL'))
  })
}
