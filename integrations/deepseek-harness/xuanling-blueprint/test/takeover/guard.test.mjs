// W1 C-07: authenticated policy bypass, NOT an anonymous-RCE claim.
// Real Cordis + installed DSH ToolRuntime + production service/adapter.
// A real monotonic host guard denies every dispatch; tools.execute is spied,
// not replaced with a throwing fake. Only a harmless temp sentinel is used.
// This still is not a booted-profile gateway/authentication journey.
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { BlueprintService } from '../../src/index.ts'
import { registerScriptTool } from '../../src/host/tool-adapter.ts'
import { TYPERT } from '../../src/typert.host.ts'

function deniedFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bp-takeover-denied-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sentinel = join(root, 'sentinel.txt')
  const scriptContent = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'harmless takeover sentinel');\nconsole.log(JSON.stringify({ ok: true }));\n`
  const registrations = new Map()
  const calls = []
  const disposals = []
  const ctx = new Context()
  // Constructor-only prompt contribution sink: no model/prompt rendering is
  // needed for this native-tool policy test. Tool dispatch/guard are REAL.
  ctx.provide('systemPrompt', { tools() { return () => {} } })
  const tools = new ToolRuntime(ctx)
  const denyReason = 'authenticated takeover policy denies blueprint script dispatch'
  const removeGuard = tools.guard(() => denyReason)
  const results = []
  const originalRegister = tools.register
  const originalExecute = tools.execute
  t.mock.method(tools, 'register', definition => {
    assert.equal(typeof definition.name, 'string')
    assert.equal(typeof definition.execute, 'function')
    const dispose = originalRegister.call(tools, definition)
    registrations.set(definition.name, definition)
    return () => { disposals.push(definition.name); registrations.delete(definition.name); dispose() }
  })
  t.mock.method(tools, 'execute', async exec => {
    assert.ok(registrations.has(exec.name), 'must exercise registered tool denial, not UNKNOWN_TOOL')
    assert.equal(typeof exec.arguments, 'object')
    assert.ok(exec.signal instanceof AbortSignal, 'host ToolExecution requires a real cancellation signal')
    calls.push(exec)
    const result = await originalExecute.call(tools, exec)
    results.push(result)
    assert.equal(result.isError, true)
    assert.equal(result.error.message, denyReason, 'real host guard must be the denial cause')
    return result
  })
  t.after(async () => { removeGuard(); await ctx.fiber.dispose() })
  return { ctx, tools, registrations, calls, results, disposals, sentinel, scriptContent }

}

async function invokeUnderGuard(f, invoke) {
  try { await invoke() }
  catch (error) {
    // A service may translate the real host denial into a typed wire failure.
    // An import/fixture failure BEFORE real denial must never count as red.
    assert.equal(f.results.length, 1, `wrong failure before host guard: ${error.stack}`)
    assert.equal(f.results[0].isError, true)
  }
}

test('C-07 production toolProbe under a denying host must not create a sentinel or bypass tools.execute', async t => {
  const f = deniedFixture(t)
  const service = new BlueprintService(f.ctx)
  // Removing the diagnostic entirely is a valid fix; retaining it requires
  // the host dispatch policy. The wire oracle below independently checks it.
  if (typeof service.toolProbe !== 'function') {
    assert.ok(!TYPERT.invocations.some(invocation => invocation.method === 'toolProbe'))
    return
  }
  await invokeUnderGuard(f, () => service.toolProbe({ scriptContent: f.scriptContent, mcpBindingId: 'unbound-test-only' }))
  assert.equal(f.registrations.size, 0, 'production diagnostic must dispose its registration even on rejection')
  assert.equal(f.disposals.length, 1)
  assert.deepEqual({
    sentinelExists: existsSync(f.sentinel),
    hostDispatches: f.calls.length,
    hostDenials: f.results.filter(result => result.isError).length,
  }, {
    sentinelExists: false,
    hostDispatches: 1,
    hostDenials: 1,
  }, 'TOOL_PROBE_POLICY_BYPASS: a denying authenticated host must run policy and prevent all script side effects')
})

test('C-07 production adapter direct diagnostic must not execute a script outside host denial policy', async t => {
  const f = deniedFixture(t)
  const registered = registerScriptTool(f.ctx, { nodeId: 'deny_fixture', scriptBytes: Buffer.from(f.scriptContent), description: 'Harmless denied test script' })
  try {
    assert.deepEqual(Object.keys(registered).sort(), ['disposer', 'name'],
      'ADAPTER_DIRECT_POLICY_BYPASS: there must be no bare execution handle')
    await invokeUnderGuard(f, () => f.tools.execute({ name: registered.name, arguments: {}, callId: 'takeover-deny', signal: new AbortController().signal }))
    assert.deepEqual({ sentinelExists: existsSync(f.sentinel), hostDispatches: f.calls.length, hostDenials: f.results.filter(result => result.isError).length },
      { sentinelExists: false, hostDispatches: 1, hostDenials: 1 },
      'ADAPTER_DIRECT_POLICY_BYPASS: adapter diagnostics must not spawn a script behind a denying tools.execute policy')
  } finally { registered.disposer() }
  assert.equal(f.registrations.size, 0)
})

test('C-07 production wire must not publish a raw script diagnostic invocation', () => {
  const rawScriptMethods = TYPERT.invocations.filter(invocation => invocation.namespace === 'blueprint'
    && invocation.parameters.some(parameter => {
      const codec = parameter.codec.create()
      return codec.shape !== undefined && Object.hasOwn(codec.shape, 'scriptContent')
    })).map(invocation => invocation.method)
  assert.deepEqual(rawScriptMethods, [], 'WIRE_RAW_SCRIPT_DIAGNOSTIC: authenticated blueprint wire must not expose the bare scriptContent diagnostic')
})

test('control: registered production adapter through host tools.execute is denied before its body runs', async t => {
  const f = deniedFixture(t)
  const registered = registerScriptTool(f.ctx, { nodeId: 'control', scriptBytes: Buffer.from(f.scriptContent), description: 'Host deny control' })
  try {
    const result = await f.tools.execute({ name: registered.name, arguments: {}, callId: 'takeover-control', signal: new AbortController().signal })
    assert.equal(result.isError, true)
    assert.equal(f.results.length, 1)
    assert.equal(f.calls.length, 1)
    assert.equal(existsSync(f.sentinel), false, 'same script stays harmless when the host policy seam is used')
  } finally { registered.disposer() }
})
