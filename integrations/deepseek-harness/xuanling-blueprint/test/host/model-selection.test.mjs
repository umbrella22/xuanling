// SOURCE-only public factory contract tests. Registry doubles are not live evidence.
// No lib import, provider request, key, profile, or build is involved.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { BlueprintAgentExecutor } from '../../src/host/agent-executor.ts'

const spec = (attemptId = 'attempt-source') => ({
  runId: 'run-source',
  attemptId,
  nodeId: 'model',
  agentMd: 'source fixture',
  skills: [],
  input: 'source-input',
  cwd: '/source-fixture',
  timeoutMs: 30000
})
function registry({ reason = { kind: 'completed' }, beforePublish, hanging = false } = {}) {
  const calls = []
  const dispatched = Promise.withResolvers()
  const host = {
    async create(options) {
      options.signal?.throwIfAborted()
      const ctx = new Context()
      ctx.provide('systemPrompt', {
        tools() {
          return () => {}
        }
      })
      new ToolRuntime(ctx, { mode: 'native' })
      const call = { options, disposed: false, cancelled: false, events: [] }
      const idle = Promise.withResolvers()
      let running = false
      const agent = {
        session: { snapshotEvents: () => call.events.slice() },
        inject() {},
        followup() {
          running = true
          dispatched.resolve(call)
          if (hanging) return
          call.events.push(
            { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'source-output' }] } } },
            { type: 'turn/end', data: { turn: 1, reason } }
          )
          running = false
          idle.resolve()
        },
        whenIdle: () => (running ? idle.promise : Promise.resolve()),
        cancel(cause) {
          if (!running) return
          running = false
          call.cancelled = true
          call.cause = cause
          call.events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
          idle.resolve()
        }
      }
      // Keep the model-owner double separate from the real scoped Tools host.
      const scope = createScope(ctx, agent)
      agent.ctx = scope.ctx
      try {
        await beforePublish?.(options)
        const publication = await options.setup?.(scope.ctx, agent)
        options.signal?.throwIfAborted()
        publication?.commit()
      } catch (error) {
        await scope.dispose()
        await ctx.fiber.dispose()
        throw error
      }
      calls.push(call)
      return {
        agent,
        async dispose() {
          if (call.disposed) return
          agent.cancel({ kind: 'disposed' })
          await agent.whenIdle()
          await scope.dispose()
          await ctx.fiber.dispose()
          call.disposed = true
        }
      }
    }
  }
  return { host, calls, dispatched: dispatched.promise }
}
function defaults(selection) {
  let current = selection,
    reads = 0
  return {
    ctx: {
      get(name) {
        assert.equal(name, 'agentDefaultModel')
        return {
          currentSelection() {
            reads++
            return current
          }
        }
      }
    },
    change(next) {
      current = next
    },
    reads: () => reads
  }
}

test('public create receives current default provider/model/reasoning in agentOptions exactly once per Attempt', async () => {
  const selected = { provider: 'provider-source', model: 'current-model', reasoningEffort: 'high' }
  const config = defaults(selected),
    h = registry()
  const result = await new BlueprintAgentExecutor(config.ctx, h.host).execute(spec())
  assert.deepEqual(h.calls[0].options.agentOptions, selected, 'SOURCE RED: public create must receive default route, not an empty AgentOptions')
  assert.notEqual(h.calls[0].options.agentOptions, selected, 'capture a detached selection, not mutable host settings')
  assert.equal(config.reads(), 1)
  assert.equal(result.outcome.kind, 'succeeded')
  assert.equal(result.outcome.detail, 'source-output')
  assert.equal(h.calls[0].disposed, true)
})

test('host changes during creation do not rewrite this Attempt; the next Attempt reads the new complete selection', async () => {
  const selected = { provider: 'provider-one', model: 'model-one', reasoningEffort: 'high' }
  const next = { provider: 'provider-two', model: 'model-two', reasoningEffort: 'low' }
  const config = defaults(selected),
    h = registry({
      beforePublish() {
        selected.model = 'mutated-host-object'
        config.change(next)
      }
    })
  const executor = new BlueprintAgentExecutor(config.ctx, h.host)
  await executor.execute(spec('attempt-one'))
  await executor.execute(spec('attempt-two'))
  assert.deepEqual(h.calls[0].options.agentOptions, { provider: 'provider-one', model: 'model-one', reasoningEffort: 'high' })
  assert.deepEqual(h.calls[1].options.agentOptions, next)
  assert.equal(config.reads(), 2)
})

test('an unspecified reasoning effort stays omitted, never inherited or guessed', async () => {
  const config = defaults({ provider: 'provider-source', model: 'current-model' }),
    h = registry()
  await new BlueprintAgentExecutor(config.ctx, h.host).execute(spec())
  assert.deepEqual(h.calls[0].options.agentOptions, { provider: 'provider-source', model: 'current-model' })
  assert.equal(Object.hasOwn(h.calls[0].options.agentOptions, 'reasoningEffort'), false)
})

test('without the default service public request-waterfall composition stays possible; an actual error remains typed failure', async () => {
  const ctx = {
    get(name) {
      assert.equal(name, 'agentDefaultModel')
      return undefined
    }
  }
  const h = registry(),
    result = await new BlueprintAgentExecutor(ctx, h.host).execute(spec())
  assert.equal(Object.hasOwn(h.calls[0].options, 'agentOptions'), false, 'do not guess a provider/model or require the default service')
  assert.equal(typeof h.calls[0].options.setup, 'function')
  assert.equal(result.outcome.kind, 'succeeded')
  const broken = registry({ reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'source fixture no model' } } })
  const failed = await new BlueprintAgentExecutor(ctx, broken.host).execute(spec())
  assert.equal(failed.outcome.kind, 'provider-failed')
  assert.equal(failed.outcome.ok, false)
  assert.equal(broken.calls[0].disposed, true)
})

test('already-cancelled Attempt does not read a model or create an Agent', async () => {
  const config = defaults({ provider: 'provider-source', model: 'current-model' }),
    h = registry()
  const result = await new BlueprintAgentExecutor(config.ctx, h.host).execute({ ...spec(), signal: AbortSignal.abort() })
  assert.equal(result.outcome.kind, 'cancelled')
  assert.equal(config.reads(), 0)
  assert.equal(h.calls.length, 0)
})

test('published cancellation preserves parent cancel, quiescence, disposal and non-success', async () => {
  const config = defaults({ provider: 'provider-source', model: 'current-model' }),
    h = registry({ hanging: true }),
    abort = new AbortController()
  const pending = new BlueprintAgentExecutor(config.ctx, h.host).execute({ ...spec(), signal: abort.signal })
  await h.dispatched
  // Wait for actual followup dispatch, not a pre-publication factory callback.
  abort.abort()
  const result = await pending
  assert.equal(result.outcome.kind, 'cancelled')
  assert.deepEqual(h.calls[0].cause, { kind: 'parent' })
  assert.equal(h.calls[0].disposed, true)
  assert.equal(config.reads(), 1)
})

test('execution deadline preserves typed timeout only after quiescence and disposal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const config = defaults({ provider: 'provider-source', model: 'current-model' }),
    h = registry({ hanging: true })
  const pending = new BlueprintAgentExecutor(config.ctx, h.host).execute(spec())
  await h.dispatched
  t.mock.timers.tick(30000)
  const result = await pending
  assert.equal(result.outcome.kind, 'timeout')
  assert.equal(result.outcome.ok, false)
  assert.deepEqual(h.calls[0].cause, { kind: 'parent' })
  assert.equal(h.calls[0].disposed, true)
  assert.equal(config.reads(), 1)
})

test('public createAgent compatibility path receives the same detached default route', async () => {
  const selected = { provider: 'provider-source', model: 'current-model', reasoningEffort: 'high' }
  const config = defaults(selected),
    h = registry()
  const legacy = {
    createAgent(ownerCtx, options) {
      assert.equal(ownerCtx, config.ctx)
      return h.host.create(options)
    }
  }
  const result = await new BlueprintAgentExecutor(config.ctx, legacy).execute(spec())
  assert.deepEqual(h.calls[0].options.agentOptions, selected)
  assert.equal(config.reads(), 1)
  assert.equal(result.outcome.kind, 'succeeded')
  assert.equal(h.calls[0].disposed, true)
})
