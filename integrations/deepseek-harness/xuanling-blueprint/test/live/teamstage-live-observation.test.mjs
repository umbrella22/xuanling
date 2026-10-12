import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../../../../test/blueprint/capabilities/teamstage-live-collector.mjs', import.meta.url), 'utf8')
const observation = source.slice(source.indexOf('async function until('), source.indexOf('\nfunction safeGateway('))
const fail = code => { throw Object.assign(new Error(code), { code }) }

function observer(clock, pause) {
  return new Function('Date', 'pause', 'fail', 'safeRun', 'safeCode', `${observation}; return observeTerminalRun`)(
    { now: () => clock.at }, pause, fail, run => ({ state: run.state, seq: run.seq }), error => error.code)
}

test('live observer follows an active slow-thinking Run beyond the old window until native terminal', async () => {
  const clock = { at: 0 }, facts = {}, seen = []
  const observe = observer(clock, async () => { clock.at += 60_000 })
  const snapshots = [{ state: 'running', seq: 2 }, { state: 'running', seq: 3 }, { state: 'succeeded', seq: 4 }]
  let reads = 0
  const run = await observe(async () => snapshots[reads++], facts, value => seen.push(value.state))
  assert.equal(reads, 3, 'slow progress must remain observable without dispatching a new Run')
  assert.equal(clock.at, 120_000)
  assert.equal(run.state, 'succeeded')
  assert.deepEqual(facts.run, { state: 'succeeded', seq: 4 })
  assert.equal(facts.observation.status, 'terminal_observed')
  assert.equal(facts.observation.budget_ms, null)
  assert.deepEqual(seen, ['running', 'running', 'succeeded'])
})

test('observer preserves native failure, cancellation, timeout and recovery after long progress', async () => {
  for (const state of ['failed', 'cancelled', 'timed_out', 'recovery_required']) {
    const clock = { at: 0 }, facts = {}
    const observe = observer(clock, async () => { clock.at += 600_000 })
    let reads = 0
    const run = await observe(async () => ++reads === 1 ? { state: 'running', seq: 1 } : { state, seq: 2 }, facts)
    assert.equal(run.state, state)
    assert.equal(facts.run.state, state)
    assert.equal(facts.observation.status, 'terminal_observed')
    assert.equal(facts.observation.budget_ms, null)
  }
})

test('host observation failure preserves last nonterminal state and typed cause without provider details', async () => {
  const clock = { at: 0 }, facts = {}
  const observe = observer(clock, async () => { clock.at += 60_000 })
  let reads = 0
  await assert.rejects(() => observe(async () => {
    if (++reads === 1) return { state: 'running', seq: 9 }
    throw Object.assign(new Error('private-host-diagnostic'), { code: 'HOST_GATEWAY_RPC_FAILED' })
  }, facts), { code: 'HOST_GATEWAY_RPC_FAILED' })
  assert.deepEqual(facts.run, { state: 'running', seq: 9 })
  assert.equal(facts.observation.status, 'failed')
  assert.equal(facts.observation.code, 'HOST_GATEWAY_RPC_FAILED')
  assert.doesNotMatch(JSON.stringify(facts), /private-host-diagnostic/)
})
