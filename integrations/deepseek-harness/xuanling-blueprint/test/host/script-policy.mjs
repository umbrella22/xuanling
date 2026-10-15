// Shared by source node:test and the built security/probe gate. These cases
// dispatch the registered production body through REAL DSH ToolRuntime.
// No provider, user profile, keys, network or throwing fake execute is used.
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch } from 'node:fs'
import { getEventListeners } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = new URL('../../../../../', import.meta.url)
const timeoutPolicyUrl = new URL('test/blueprint/node_modules/@deepseek-ai/dsh-tool-call-timeout-policy/lib/index.js', repoRoot)

function stopped(pid) {
  assert.throws(
    () => process.kill(pid, 0),
    error => error.code === 'ESRCH',
    `script PID ${pid} must be reaped before dispatch settles`
  )
}

function assertClean(marker) {
  const started = JSON.parse(readFileSync(marker, 'utf8'))
  stopped(started.pid)
  assert.ok(started.cwd.startsWith(join(realpathSync(tmpdir()), 'bp-script-')), 'adapter must use platform temp directory')
  assert.equal(existsSync(started.cwd), false, 'owned execution directory must be gone before host result')
  return started
}

function ready(root, marker) {
  // A readiness handshake, not a sleep to mask a lifecycle race.
  return new Promise((resolve, reject) => {
    const observer = watch(root, () => {
      if (!existsSync(marker)) return
      try {
        JSON.parse(readFileSync(marker, 'utf8'))
      } catch {
        return
      }
      clearTimeout(timer)
      observer.close()
      resolve()
    })
    const timer = setTimeout(() => {
      observer.close()
      reject(new Error('script did not reach readiness handshake in 5 seconds'))
    }, 5000)
    if (existsSync(marker)) {
      clearTimeout(timer)
      observer.close()
      resolve()
    }
  })
}

async function fixture(adapter, run, { guard, hostTimeout = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bp-takeover-script-policy-'))
  const marker = join(root, 'started.json')
  const late = join(root, 'late.txt')
  const ctx = new Context()
  ctx.provide('systemPrompt', {
    tools() {
      return () => {}
    }
  })
  const tools = new ToolRuntime(ctx)
  const registrations = []
  const executions = []
  const pending = []
  const controllers = []
  let guardCalls = 0
  const removeGuard = tools.guard(() => {
    guardCalls++
    return guard
  })
  const register = (body, options = {}) => {
    const registered = adapter.registerScriptTool(ctx, {
      nodeId: `policy_${registrations.length}`,
      description: 'Harmless policy contract script',
      scriptBytes: Buffer.isBuffer(body) ? body : Buffer.from(body),
      ...options
    })
    assert.deepEqual(Object.keys(registered).sort(), ['disposer', 'name'], 'registration must expose no direct execution handle')
    registrations.push(registered)
    return registered
  }
  const dispatch = (registered, args = {}, controller = new AbortController()) => {
    controllers.push(controller)
    const input = { name: registered.name, arguments: args, callId: `policy-${executions.length}`, signal: controller.signal }
    executions.push(input)
    const promise = tools.execute(input)
    pending.push(promise)
    return promise
  }
  const script = (body = '') =>
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,cwd:process.cwd()}));\n${body}`
  try {
    if (hostTimeout) {
      // Installed real DSH wrapper; missing dependency must fail, never skip.
      const { apply } = await import(timeoutPolicyUrl.href)
      apply(ctx)
    }
    return await run({ root, marker, late, ctx, tools, register, dispatch, script, ready: () => ready(root, marker), guardCalls: () => guardCalls, executions })
  } finally {
    controllers.forEach(controller => controller.abort())
    await Promise.allSettled(pending)
    registrations.forEach(registered => registered.disposer())
    registrations.forEach(registered => assert.equal(tools.get(registered.name), undefined, 'registration must be disposed'))
    removeGuard()
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}

export function scriptPolicyCases(adapter) {
  return [
    {
      id: 'HOST-SCRIPT-DSH-BUDGET',
      title: 'scripts without a configured deadline inherit the DSH execution signal',
      run: () =>
        fixture(
          adapter,
          async f => {
            const tool = f.register(f.script())
            assert.equal(f.tools.get(tool.name).timeoutMs, undefined, 'Blueprint must not declare a private script budget')
            const result = await f.dispatch(tool)
            assert.equal(result.isError, false)
            return { ok: true, detail: JSON.stringify(assertClean(f.marker)) }
          },
          { hostTimeout: true }
        )
    },
    {
      id: 'HOST-SCRIPT-CONFIGURED-BUDGET',
      title: 'explicit host script metadata is not capped at a Blueprint default',
      run: () =>
        fixture(adapter, async f => {
          const tool = f.register(f.script(), { timeoutMs: 120000 })
          assert.equal(f.tools.get(tool.name).timeoutMs, 120000)
          const result = await f.dispatch(tool)
          assert.equal(result.isError, false)
          return { ok: true, detail: JSON.stringify(assertClean(f.marker)) }
        })
    },
    {
      id: 'HOST-SCRIPT-ALLOW',
      title: 'real ToolRuntime allows one frozen script, lossless argv and no directory/process leak',
      run: () =>
        fixture(adapter, async f => {
          const bytes = Buffer.from(f.script(`console.log(JSON.stringify({answer:42,args:JSON.parse(process.argv[3])}));`))
          const tool = f.register(bytes, { timeoutMs: 5000 })
          bytes.fill(0) // registration owns snapshot bytes, not the caller's mutable Buffer
          const args = { probe: '合法 awkward " / 路径', timeoutMs: 1, nested: { n: 42 } }
          const signal = new AbortController()
          const listeners = getEventListeners(signal.signal, 'abort').length
          const result = await f.dispatch(tool, args, signal)
          assert.equal(result.isError, false)
          assert.equal(result.value.ok, true)
          assert.equal(result.value.kind, 'succeeded')
          assert.equal(result.value.effect, 'unknown')
          assert.deepEqual(JSON.parse(result.value.stdout), { answer: 42, args })
          assert.equal(f.tools.get(tool.name).timeoutMs, 5000, 'caller timeoutMs is data, not execution settings')
          assert.equal(f.guardCalls(), 1)
          assert.equal(f.executions.length, 1)
          assert.equal(getEventListeners(signal.signal, 'abort').length, listeners, 'abort listeners must be released')
          return { ok: true, detail: JSON.stringify({ ...assertClean(f.marker), dispatches: 1, effect: result.value.effect }) }
        })
    },
    {
      id: 'HOST-SCRIPT-DENY',
      title: 'real monotonic guard rejects before the script body, with zero side effects',
      run: () =>
        fixture(
          adapter,
          async f => {
            const tool = f.register(f.script())
            const result = await f.dispatch(tool)
            assert.equal(result.isError, true)
            assert.equal(result.error.message, 'takeover policy denies scripts')
            assert.equal(f.guardCalls(), 1)
            assert.equal(f.executions.length, 1)
            assert.equal(existsSync(f.marker), false)
            return { ok: true, detail: 'real host denial, one dispatch, zero body starts' }
          },
          { guard: 'takeover policy denies scripts' }
        )
    },
    {
      id: 'HOST-SCRIPT-FAILED',
      title: 'nonzero script exit is host isError, unknown effect, no retry or process leak',
      run: () =>
        fixture(adapter, async f => {
          const tool = f.register(f.script('process.exit(3)'))
          const result = await f.dispatch(tool)
          assert.equal(result.isError, true, 'a failed script must not become a successful host ToolResult')
          assert.match(result.error.message, /SCRIPT_FAILED:.*effect=unknown/)
          assert.equal(f.executions.length, 1)
          return { ok: true, detail: JSON.stringify(assertClean(f.marker)) }
        })
    },
    {
      id: 'HOST-SCRIPT-PREABORT',
      title: 'pre-aborted host execution never dispatches the body or bypasses cancellation',
      run: () =>
        fixture(adapter, async f => {
          const controller = new AbortController()
          controller.abort(new Error('controlled pre-abort'))
          const result = await f.dispatch(f.register(f.script()), {}, controller)
          assert.equal(result.isError, true)
          assert.equal(result.error.info.code, 'ABORTED_BEFORE_DISPATCH')
          assert.equal(f.guardCalls(), 0)
          assert.equal(existsSync(f.marker), false)
          return { ok: true, detail: 'ABORTED_BEFORE_DISPATCH; zero guard/body entries' }
        })
    },
    {
      id: 'HOST-SCRIPT-CANCEL',
      title: 'caller cancellation waits for a started script to stop and cleanup; effect is unknown',
      run: () =>
        fixture(adapter, async f => {
          const controller = new AbortController()
          const listeners = getEventListeners(controller.signal, 'abort').length
          const tool = f.register(f.script(`setTimeout(() => writeFileSync(${JSON.stringify(f.late)}, 'late'), 30000);`))
          const resultPromise = f.dispatch(tool, {}, controller)
          try {
            await f.ready()
          } catch (error) {
            controller.abort()
            await resultPromise
            throw error
          }
          controller.abort(new Error('controlled post-start cancellation'))
          const result = await resultPromise
          assert.equal(result.isError, true)
          assert.match(result.error.message, /SCRIPT_CANCELLED:.*effect=unknown/)
          assert.equal(f.executions.length, 1)
          assert.equal(existsSync(f.late), false)
          assert.equal(getEventListeners(controller.signal, 'abort').length, listeners)
          return { ok: true, detail: JSON.stringify(assertClean(f.marker)) }
        })
    },
    {
      id: 'HOST-SCRIPT-TIMEOUT',
      title: 'real DSH timeout policy aborts the script and drains it before TOOL_TIMEOUT',
      run: () =>
        fixture(
          adapter,
          async f => {
            const tool = f.register(f.script(`setTimeout(() => writeFileSync(${JSON.stringify(f.late)}, 'late'), 30000);`), { timeoutMs: 1000 })
            const result = await f.dispatch(tool, { timeoutMs: 999999 })
            assert.equal(result.isError, true)
            assert.equal(result.error.info.code, 'TOOL_TIMEOUT', 'must observe the real host timeout wrapper, not a direct primitive timer')
            assert.equal(f.executions.length, 1)
            assert.equal(existsSync(f.late), false)
            return { ok: true, detail: JSON.stringify(assertClean(f.marker)) }
          },
          { hostTimeout: true }
        )
    },
    {
      id: 'HOST-SCRIPT-INTERNAL-TIMEOUT',
      title: 'registered internal hard budget also fails through tools.execute without a timeout wrapper',
      run: () =>
        fixture(adapter, async f => {
          const result = await f.dispatch(f.register(f.script('setInterval(() => {}, 1000)'), { timeoutMs: 1000 }), { timeoutMs: 999999 })
          assert.equal(result.isError, true)
          assert.match(result.error.message, /SCRIPT_TIMEOUT:.*effect=unknown/)
          assert.equal(f.executions.length, 1)
          return { ok: true, detail: JSON.stringify(assertClean(f.marker)) }
        })
    }
  ]
}

export async function builtScriptPolicyCases(packageRoot) {
  const adapter = await import(pathToFileURL(join(packageRoot, 'lib', 'tool-adapter.js')).href)
  return scriptPolicyCases(adapter).map(c => ({ ...c, contract: 'C-07', expect: 'pass' }))
}
