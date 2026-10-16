import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { harness, definition, runArgs, drain, records } from './agent-fixtures.mjs'

// Resolve the retry policy shipped by the pinned DSH base profile. The public
// Agent factory seam is scripted; recovery policy, executor, driver and store
// are production code. A real AgentLoop/provider journey is a separate gate.
const dshRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-base'))
const retry = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-llm-retry')).href)

for (const cancel of [false, true]) {
  test(`native request retry remains the same running Attempt until ${cancel ? 'cancel quiescence' : 'successful completion'}`, async t => {
    const recovered = Promise.withResolvers()
    const release = Promise.withResolvers()
    const h = await harness(t, {
      onTurn: async call => {
        const decision = await agentEvents(call.agent.ctx, call.agent).waterfall(
          'agent/request-error',
          {
            turn: 1,
            step: 1,
            provider: 'contract-provider',
            failure: { code: 'TRANSPORT', message: 'controlled transient failure' },
            retryPolicy: { mode: 'normal', maxRetries: 1, retryableCodes: ['TRANSPORT'], initialDelayMs: 0, maxDelayMs: 1, jitterRatio: 0 },
            signal: call.options.signal
          },
          async () => undefined
        )
        recovered.resolve({ call, decision })
        await release.promise
        call.finish()
      }
    })
    await h.ctx.plugin(SessionProjections)
    await h.ctx.plugin(retry)
    const doc = await h.save(definition())
    const admitted = await h.service.startRun(runArgs(doc))
    try {
      const { call, decision } = await recovered.promise
      assert.deepEqual(decision, { kind: 'retry' })
      const events = call.session.snapshotEvents()
      assert.equal(events.filter(event => event.type === 'llm/retry').length, 1)
      assert.equal(events.filter(event => event.type === 'llm/retry-started').length, 1)
      assert.equal(
        events.some(event => event.type === 'turn/end'),
        false
      )
      const during = (await records(h)).find(run => run.runId === admitted.runId)
      assert.equal(during.state, 'running')
      assert.equal(during.attempts.length, 1)
      assert.equal(during.attempts[0].state, 'running')
      assert.equal(during.attempts[0].result, undefined)
      assert.equal(during.attempts[0].sessionId, call.session.id)
      if (cancel) await h.service.cancelRun({ runId: admitted.runId })
    } finally {
      release.resolve()
      await drain(h)
    }
    const after = (await records(h)).find(run => run.runId === admitted.runId)
    assert.equal(after.state, cancel ? 'cancelled' : 'succeeded')
    assert.equal(after.attempts.length, 1)
    assert.equal(after.attempts[0].state, after.state)
    assert.equal(h.host.calls.length, 1, 'provider retry does not create a new Blueprint Agent or Attempt')
  })
}
