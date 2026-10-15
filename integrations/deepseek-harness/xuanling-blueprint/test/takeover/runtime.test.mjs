/**
 * W1 / Worker A: SOURCE regressions, not lib/build tests or live-provider evidence.
 * Run: node --experimental-transform-types --test <absolute path to this file>
 *
 * Host double follows DSH core/agent/src/{index,runtime-types}.ts and
 * core/agent-loop/src/agent.ts: setup precedes publication, followup returns
 * void, whenIdle means quiescence only, cancel accepts AgentCancelCause, and
 * settlement is read from a REAL public Session's durable turn/end reason.
 * No invented completion event, waitForResult, or creation-signal lifetime.
 *
 * Upstream-agent-output/resource cases replace the external execution boundary
 * with a controlled outcome to isolate them from the separate executor-success
 * defect. They still call production startRun/driveRun and REAL JSON RunStore.
 * The lifecycle/failure/cancel cases invoke the real executor with the registry.
 * RPC completion is admission/decision acknowledgement, NOT driver completion.
 * A pass-through observer tracks the actual driveRun promises for cleanup/drain;
 * bounded event-loop turns plus durable snapshots observe eventual outcomes.
 * No production driver implementation is replaced by this observer.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { BlueprintService } from '../../src/index.ts'
import { BlueprintAgentExecutor } from '../../src/host/agent-executor.ts'
import { decodeDefinition, validateDefinition } from '../../src/definition/index.ts'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'
import { reconcileOnStart } from '../../src/orchestration/recovery.ts'

const sha256 = value => createHash('sha256').update(value).digest('hex')
const deferred = () => Promise.withResolvers()
const textOf = message =>
  message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
const COMPLETED = { kind: 'completed' }
const PROVIDER_ERROR = { kind: 'error', error: { code: 'UNKNOWN', message: 'controlled provider failure (no external request)' } }

function registryDouble(onTurn = turn => turn.finish(COMPLETED, 'HOST_OUTPUT_SENTINEL')) {
  const calls = []
  const started = deferred()
  let ownerCtx
  const registry = {
    async create(options) {
      options.signal?.throwIfAborted()
      let agentCtx
      const id = SessionId(options.sessionId)
      const session = Session.create(
        id,
        options.seed,
        {
          version: SESSION_FORMAT_VERSION,
          id,
          createdAt: Date.now(),
          isSeeded: false,
          ...options.meta
        },
        options.inheritedEventCount
      )
      const idle = deferred()
      const controller = new AbortController()
      const call = {
        options,
        session,
        controller,
        injections: [],
        followups: [],
        cancelCalls: [],
        disposed: false,
        finish(reason, output = '') {
          if (agent.status === 'idle') return
          if (output) {
            session.append(
              'assistant/message',
              {
                turn: 1,
                step: 1,
                stream: [],
                message: createMessage({ role: 'assistant', content: [{ type: 'text', text: output }] }),
                ...(reason.kind === 'aborted' ? { interrupted: true } : {})
              },
              { surfaceOp: 'append' }
            )
          }
          session.append('turn/end', { turn: 1, reason })
          if (reason.kind === 'error') agentCtx.emit('agent/error', { agent, turn: 1, step: 1, error: reason.error })
          agent.status = 'idle'
          agentCtx.emit('agent/status', { agent, status: 'idle' })
          idle.resolve()
        }
      }
      const agent = {
        id: session.id,
        session,
        ctx: agentCtx,
        status: 'idle',
        inject(message) {
          call.injections.push(textOf(message))
          session.append('agent/inbox/spliced', { target: 'next-step', start: call.injections.length - 1, inserted: [message] })
          agentCtx.emit('agent/inbox/inserted', { agent, message })
        },
        followup(message) {
          call.followups.push(textOf(message))
          session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
          agent.status = 'running'
          agentCtx.emit('agent/status', { agent, status: 'running' })
          session.append('turn/start', { turn: 1 })
          session.append('user/message', message, { surfaceOp: 'append' })
          started.resolve(call)
          onTurn(call)
        },
        whenIdle() {
          return agent.status === 'idle' ? Promise.resolve() : idle.promise
        },
        cancel(cause, options = {}) {
          call.cancelCalls.push({ cause, options })
          if (agent.status !== 'idle') {
            controller.abort(cause)
            call.finish({ kind: 'aborted', reason: cause })
          }
        }
      }
      const scope = createScope(ownerCtx, agent)
      agentCtx = scope.ctx
      agent.ctx = agentCtx
      call.agent = agent
      // Public setup(agentCtx, agent) may return a publication commit.
      try {
        const commit = await options.setup?.(agentCtx, agent)
        options.signal?.throwIfAborted()
        commit?.commit()
      } catch (error) {
        await scope.dispose()
        throw error
      }
      calls.push(call) // publish only after setup and its commit
      agentCtx.emit('agent/created', { agent, source: 'startup', ...(options.signal ? { signal: options.signal } : {}) })
      return {
        agent,
        async dispose() {
          if (call.disposed) return
          if (agent.status !== 'idle') agent.cancel({ kind: 'disposed' })
          await agent.whenIdle()
          call.disposed = true
          await scope.dispose()
        }
      }
    }
  }
  return {
    registry,
    calls,
    started: started.promise,
    bindOwner(ctx) {
      ownerCtx = ctx
    }
  }
}

async function harness(t, host = registryDouble()) {
  const root = mkdtempSync(join(tmpdir(), 'bp-takeover-runtime-'))
  const rootDir = join(root, 'package')
  const runtimeRoot = join(root, 'runtime')
  mkdirSync(join(rootDir, 'lib', 'agents'), { recursive: true })
  mkdirSync(runtimeRoot)
  writeFileSync(join(rootDir, 'lib', 'agents', 'worker.md'), 'PACKAGE_AGENT_ORIGINAL')
  const ctx = new Context()
  ctx.provide('systemPrompt', {
    tools() {
      return () => {}
    },
    section() {
      return () => {}
    },
    getSectionOrder() {
      return 100
    }
  })
  new ToolRuntime(ctx, { mode: 'native' })
  host.bindOwner(ctx)
  ctx.provide('agents', host.registry)
  const fiber = await ctx.plugin(BlueprintService)
  const service = ctx.blueprint
  const drivers = new Set()
  const driverErrors = []
  const originalDrive = service.driveRun
  t.mock.method(service, 'driveRun', function (...args) {
    const running = originalDrive.apply(this, args)
    drivers.add(running)
    running.then(
      () => drivers.delete(running),
      error => {
        drivers.delete(running)
        driverErrors.push(error)
      }
    )
    return running
  })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await fiber.dispose()
  }
  t.after(async () => {
    await close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, rootDir, runtimeRoot, ctx, service, host, close, t, drivers, driverErrors, clockTickMs: 0 }
}

function definition(nodes, edges = [], resources = {}) {
  const value = {
    schemaVersion: 1,
    id: 'takeover-runtime',
    name: 'Takeover source regression',
    resources,
    graph: { nodes, edges }
  }
  // Schema/import/fixture failures occur BEFORE any target assertion and are
  // categorically not W1 red evidence.
  validateDefinition(decodeDefinition(JSON.stringify(value)))
  return value
}
const agentResource = { worker: { kind: 'agent', path: 'lib/agents/worker.md' } }
const agentNode = (id = 'work', extra = {}) => ({ id, kind: 'agentTask', agentRef: 'worker', ...extra })
const oneAgent = () => definition([agentNode()], [], agentResource)
const argsFor = (h, value, input = { task: 'REAL_INPUT_SENTINEL' }) => ({
  definitionJson: JSON.stringify(value),
  inputJson: JSON.stringify(input),
  rootDir: h.rootDir,
  runtimeRoot: h.runtimeRoot,
  requestId: randomUUID()
})

async function readRuns(runtimeRoot) {
  const opened = await openBlueprintDomain({ backend: 'json', path: join(runtimeRoot, 'store') })
  try {
    const store = new RunStore(opened.domain)
    return await Promise.all((await store.listRunIds()).map(id => store.get(id)))
  } finally {
    await opened.close()
  }
}
async function readRun(h, runId) {
  const runs = await readRuns(h.runtimeRoot)
  const run = runs.find(record => record.runId === runId)
  assert.ok(run, 'fixture control: production service persisted the admitted Run')
  return run
}

function completedEvidence(spec, detail = 'HOST_OUTPUT_SENTINEL') {
  return {
    sessionId: `controlled-${spec.attemptId}`,
    agentCreated: true,
    scopedInjections: [],
    inboxSplicedSeen: true,
    outcome: { ok: true, kind: 'succeeded', detail }
  }
}
function executionBoundary(t, effect = () => {}) {
  const specs = []
  t.mock.method(BlueprintAgentExecutor.prototype, 'execute', async spec => {
    specs.push(structuredClone(spec))
    return (await effect(spec, specs.length)) ?? completedEvidence(spec)
  })
  return specs
}

// Only virtualize the production deadline: no sleep, weakened assertion, or
// expanded timeout. Event-loop turns let REAL JSON backend I/O finish; ticks
// make the existing timeout bug deterministic without 50 * 20s wall-clock.
async function finishWithClock(t, promise, tickMs = 100, snapshot) {
  let done = false
  let value
  let error
  promise.then(
    result => {
      value = result
      done = true
    },
    reason => {
      error = reason
      done = true
    }
  )
  for (let turns = 0; !done && turns < 20_000; turns++) {
    await nextEventLoopTurn()
    if (snapshot) await snapshot()
    if (tickMs > 0) t.mock.timers.tick(tickMs)
  }
  assert.ok(done, 'fixture control: execution drained within bounded virtual-clock event turns')
  if (error) throw error
  return value
}

// The admission RPC may return before the driver starts, so a durable snapshot
// (rather than the RPC's state) is the oracle. Bounded I/O/event turns are not
// wall-clock sleeps or a success fallback: callers assert the final snapshot.
async function drainDrivers(h) {
  await nextEventLoopTurn()
  while (h.drivers.size) {
    await finishWithClock(h.t, Promise.all(h.drivers), h.clockTickMs, () => readRuns(h.runtimeRoot))
  }
  assert.deepEqual(h.driverErrors, [], 'fixture control: actual production driver had no unrelated rejection')
}
async function eventualRun(h, runId, predicate) {
  let record
  for (let observations = 0; observations < 64; observations++) {
    await drainDrivers(h)
    record = await readRun(h, runId)
    if (predicate(record)) return record
    await nextEventLoopTurn()
  }
  return record // Preserve the precise behavior assertion on the last durable facts.
}
const isSettledOrWaiting = record => ['succeeded', 'failed', 'cancelled', 'timed_out', 'waiting_input', 'recovery_required'].includes(record.state)
async function admitAndDrain(h, args) {
  const admitted = await finishWithClock(h.t, h.service.startRun(args), h.clockTickMs, () => readRuns(h.runtimeRoot))
  assert.equal(typeof admitted.runId, 'string', 'control: admission returns its durable runId')
  await eventualRun(h, admitted.runId, isSettledOrWaiting)
  return admitted
}

const directSpec = h => ({
  runId: 'executor-source',
  attemptId: 'attempt-source',
  nodeId: 'work',
  agentMd: 'FROZEN_AGENT',
  skills: [],
  input: 'REAL_EXECUTOR_INPUT',
  cwd: h.rootDir,
  timeoutMs: 1_000
})

test('C-03 executor: durable completed turn is succeeded, not timeout', async t => {
  const h = await harness(t)
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const executor = new BlueprintAgentExecutor(h.ctx, h.host.registry)
  const evidence = await finishWithClock(t, executor.execute(directSpec(h)))
  const call = h.host.calls[0]
  assert.equal(call.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
  assert.equal(call.agent.status, 'idle')
  assert.equal(call.disposed, true)
  assert.equal(evidence.outcome.kind, 'succeeded', 'TARGET: public completed turn must settle succeeded instead of timing out')
  assert.equal(evidence.outcome.ok, true)
  assert.match(evidence.outcome.detail, /HOST_OUTPUT_SENTINEL/, 'TARGET: result comes from the durable assistant output')
})

test('C-03 executor: idle max-tokens is partial/failure, never succeeded or timeout', async t => {
  const h = await harness(
    t,
    registryDouble(turn => turn.finish({ kind: 'max-tokens' }, 'PARTIAL_OUTPUT_SENTINEL'))
  )
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const evidence = await finishWithClock(t, new BlueprintAgentExecutor(h.ctx, h.host.registry).execute(directSpec(h)))
  const reason = h.host.calls[0].session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason
  assert.deepEqual(reason, { kind: 'max-tokens' })
  assert.equal(evidence.outcome.ok, false, 'TARGET: output-token ceiling is not successful completion')
  assert.notEqual(evidence.outcome.kind, 'succeeded')
  assert.notEqual(evidence.outcome.kind, 'timeout', 'TARGET: settled max-tokens is not an unobserved timeout')
})

test('C-03 service executor-success: a real completed public Agent makes the Run succeeded', async t => {
  const h = await harness(t)
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  h.clockTickMs = 20_000
  const result = await admitAndDrain(h, argsFor(h, oneAgent()))
  assert.ok(h.host.calls.length > 0)
  assert.ok(h.host.calls.every(call => call.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind === 'completed'))
  const record = await eventualRun(h, result.runId, record => record.state === 'succeeded')
  assert.equal(record.state, 'succeeded', 'TARGET: genuine completed host turns must eventually produce a succeeded Run, not running/failed/timeout')
  assert.equal(record.attempts.length, 1)
  assert.equal(record.attempts[0].result.outcome.ok, true)
})

test('C-03 non-blocking admission: startRun returns durable runId while the public Agent remains in flight', async t => {
  const host = registryDouble(() => {})
  const h = await harness(t, host)
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  h.clockTickMs = 20_000
  let returned = false
  let admitted
  const rpc = h.service.startRun(argsFor(h, oneAgent())).then(value => {
    returned = true
    admitted = value
    return value
  })
  const call = await host.started
  const durable = (await readRuns(h.runtimeRoot))[0]
  let returnedBeforeRelease
  let admittedRunId
  try {
    assert.ok(durable.attempts[0].intent && !durable.attempts[0].result)
    for (let observations = 0; observations < 64 && !returned; observations++) {
      await nextEventLoopTurn()
      await readRun(h, durable.runId)
    }
    returnedBeforeRelease = returned
    admittedRunId = admitted?.runId
    assert.equal(call.agent.status, 'running', 'control: public Agent is still held at the barrier')
  } finally {
    await h.service.cancelRun({ runtimeRoot: h.runtimeRoot, runId: durable.runId })
    call.finish({ kind: 'aborted', reason: { kind: 'user' } })
    await finishWithClock(t, rpc, h.clockTickMs, () => readRuns(h.runtimeRoot))
    await drainDrivers(h)
  }
  assert.equal(returnedBeforeRelease, true, 'TARGET: startRun must acknowledge admission before the held external execution finishes')
  assert.equal(admittedRunId, durable.runId, 'TARGET: non-blocking acknowledgement identifies the already durable Run')
})

test('C-03 executor: durable aborted turn is not success or an unobserved timeout', async t => {
  const h = await harness(
    t,
    registryDouble(turn => turn.finish({ kind: 'aborted', reason: { kind: 'user' } }, 'PARTIAL_ABORTED_OUTPUT'))
  )
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const evidence = await finishWithClock(t, new BlueprintAgentExecutor(h.ctx, h.host.registry).execute(directSpec(h)))
  assert.equal(h.host.calls[0].session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'aborted')
  assert.equal(evidence.outcome.ok, false, 'TARGET: aborted partial output is never successful completion')
  assert.notEqual(evidence.outcome.kind, 'timeout', 'TARGET: a durable aborted turn is already settled and cannot be called timeout')
})

test('C-03 executor control: durable provider error remains typed failure', async t => {
  const h = await harness(
    t,
    registryDouble(turn => turn.finish(PROVIDER_ERROR))
  )
  const evidence = await new BlueprintAgentExecutor(h.ctx, h.host.registry).execute(directSpec(h))
  assert.equal(evidence.outcome.ok, false)
  assert.equal(evidence.outcome.kind, 'provider-failed')
  assert.equal(h.host.calls[0].disposed, true)
})

test('C-03 driver-input: startRun passes the real input through the real executor to Agent.followup', async t => {
  const h = await harness(
    t,
    registryDouble(turn => turn.finish(PROVIDER_ERROR))
  )
  await admitAndDrain(h, argsFor(h, oneAgent()))
  assert.ok(h.host.calls.length > 0, 'control: production agentTask reached the public registry')
  assert.match(h.host.calls[0].followups[0], /REAL_INPUT_SENTINEL/, 'TARGET: actual startRun input must reach public Agent.followup')
  assert.doesNotMatch(h.host.calls[0].followups[0], /^blueprint node input$/)
})

test('C-03 driver-data: upstream input port data reaches the consuming public Agent', async t => {
  const h = await harness(
    t,
    registryDouble(turn => turn.finish(PROVIDER_ERROR))
  )
  const value = definition(
    [
      { id: 'source', kind: 'input', outputs: { payload: 'json' } },
      agentNode('consume', { inputs: { request: 'json' } }),
      { id: 'sink', kind: 'output', inputs: { result: 'json' } }
    ],
    [{ kind: 'data', from: 'source.payload', to: 'consume.request' }],
    agentResource
  )
  const result = await admitAndDrain(h, argsFor(h, value, { payload: { task: 'UPSTREAM_DATA_SENTINEL', amount: 7 } }))
  const record = await readRun(h, result.runId)
  assert.equal(record.attempts.find(attempt => attempt.nodeId === 'source').state, 'succeeded')
  assert.ok(h.host.calls.length > 0)
  assert.match(h.host.calls[0].followups[0], /UPSTREAM_DATA_SENTINEL/, 'TARGET: data-edge payload cannot be replaced by a placeholder')
  assert.match(h.host.calls[0].followups[0], /7/)
})

test('C-03 driver-data: settled upstream agent output binds to the next agent input', async t => {
  const h = await harness(t)
  const specs = executionBoundary(t, spec => completedEvidence(spec, 'UPSTREAM_AGENT_OUTPUT_SENTINEL'))
  const value = definition(
    [agentNode('produce', { outputs: { answer: 'string' } }), agentNode('consume', { inputs: { question: 'string' } })],
    [{ kind: 'data', from: 'produce.answer', to: 'consume.question' }],
    agentResource
  )
  const result = await admitAndDrain(h, argsFor(h, value))
  const record = await readRun(h, result.runId)
  assert.equal(record.attempts[0].result.outcome.detail, 'UPSTREAM_AGENT_OUTPUT_SENTINEL')
  assert.equal(specs.length, 2)
  assert.match(specs[1].input, /UPSTREAM_AGENT_OUTPUT_SENTINEL/, 'TARGET: persisted upstream result must be bound to downstream input')
})

function resourceFixture(h) {
  const skillsRoot = join(h.root, 'shared-skills')
  const skillDir = join(skillsRoot, 'shared-review')
  mkdirSync(join(skillDir, 'scripts'), { recursive: true })
  mkdirSync(join(skillDir, 'references'), { recursive: true })
  mkdirSync(join(skillDir, 'assets'), { recursive: true })
  writeFileSync(join(h.runtimeRoot, 'root-bindings.json'), JSON.stringify({ roots: [{ rootId: 'isolated-root', rootPath: skillsRoot }] }))
  const writeSkill = version => {
    writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: shared-review\ndescription: Isolated test skill\n---\nSHARED_SKILL_${version}`)
    writeFileSync(join(skillDir, 'scripts', 'helper.mjs'), `// SHARED_SCRIPT_${version}`)
    writeFileSync(join(skillDir, 'references', 'guide.md'), `SHARED_REFERENCE_${version}`)
    writeFileSync(join(skillDir, 'assets', 'sample.bin'), Buffer.from([0, 1, version === 'FIRST' ? 2 : 3, 255]))
  }
  writeSkill('FIRST')
  const value = definition(
    [agentNode('first', { skillRefs: ['review'] }), agentNode('second', { skillRefs: ['review'] }), { id: 'done', kind: 'output' }],
    [
      { kind: 'control', from: 'first', to: 'second' },
      { kind: 'control', from: 'second', to: 'done' }
    ],
    {
      ...agentResource,
      review: { kind: 'skill', source: { kind: 'shared', rootId: 'isolated-root', path: 'shared-review' } }
    }
  )
  writeFileSync(join(h.rootDir, 'blueprint.json'), JSON.stringify(value))
  return { value, writeSkill, skillDir }
}
function cwdTree(cwd) {
  const result = {}
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) result[relative(cwd, path).split('\\').join('/')] = readFileSync(path)
    }
  }
  walk(cwd)
  return result
}
async function twoResourceAttempts(t, h, inspect = () => {}) {
  const fixture = resourceFixture(h)
  const trees = []
  const specs = executionBoundary(t, async (spec, ordinal) => {
    trees.push(cwdTree(spec.cwd))
    await inspect(spec, ordinal)
    if (ordinal === 1) {
      fixture.writeSkill('SECOND')
      writeFileSync(join(h.rootDir, 'lib', 'agents', 'worker.md'), 'PACKAGE_AGENT_CHANGED_AFTER_RUN_START')
      const changed = structuredClone(fixture.value)
      changed.graph.nodes = [{ id: 'mutated', kind: 'output' }]
      changed.graph.edges = []
      writeFileSync(join(h.rootDir, 'blueprint.json'), JSON.stringify(changed))
    }
  })
  const args = argsFor(h, fixture.value)
  const result = await admitAndDrain(h, args)
  assert.equal(specs.length, 2, 'control: both Attempts ran within the same admitted Run')
  return { specs, trees, result, args, fixture }
}

test('C-04 driver-skill-update: every new Attempt uses the latest shared SKILL.md', async t => {
  const h = await harness(t)
  const { specs } = await twoResourceAttempts(t, h)
  assert.match(specs[0].skills.map(skill => skill.content).join('\n'), /SHARED_SKILL_FIRST/, 'TARGET: first Attempt receives shared Skill, not empty skills')
  assert.match(specs[1].skills.map(skill => skill.content).join('\n'), /SHARED_SKILL_SECOND/, 'TARGET: new Attempt refreshes shared Skill from its bound root')
  assert.doesNotMatch(specs[0].skills.map(skill => skill.content).join('\n'), /SHARED_SKILL_SECOND/, 'TARGET: original frozen Attempt must not mutate')
})

test('C-04 driver-skill-update: second Attempt independently sees updated Skill bytes', async t => {
  const h = await harness(t)
  const { specs } = await twoResourceAttempts(t, h)
  assert.match(specs[1].skills.map(skill => skill.content).join('\n'), /SHARED_SKILL_SECOND/, 'TARGET: updated Skill must reach the second Attempt')
})

for (const [suffix, description, expected] of [
  ['scripts/helper.mjs', 'scripts', index => Buffer.from(`// SHARED_SCRIPT_${index === 0 ? 'FIRST' : 'SECOND'}`)],
  ['references/guide.md', 'references', index => Buffer.from(`SHARED_REFERENCE_${index === 0 ? 'FIRST' : 'SECOND'}`)],
  ['assets/sample.bin', 'binary assets', index => Buffer.from([0, 1, index + 2, 255])]
]) {
  test(`C-04 driver-skill-tree: full ${description} bytes are materialized per Attempt`, async t => {
    const h = await harness(t)
    const { trees } = await twoResourceAttempts(t, h)
    for (const index of [0, 1]) {
      const bytes = Object.entries(trees[index]).find(([path]) => path === suffix || path.endsWith(`/${suffix}`))?.[1]
      assert.deepEqual(bytes, expected(index), `TARGET: Attempt ${index + 1} needs full ${suffix} bytes, not only SKILL.md`)
    }
  })
}

test('C-04 driver-resource-digests: nonempty content digests are durable before dispatch', async t => {
  const h = await harness(t)
  const observed = []
  const { result } = await twoResourceAttempts(t, h, async spec => {
    const record = (await readRuns(h.runtimeRoot))[0]
    const attempt = record.attempts.find(item => item.attemptId === spec.attemptId)
    assert.ok(attempt?.intent, 'control: production intent committed before execution boundary')
    observed.push(structuredClone(attempt.intent.resourceDigests))
  })
  const record = await readRun(h, result.runId)
  for (const digests of observed) {
    assert.ok(Object.keys(digests).length >= 2, 'TARGET: dispatch intent must contain agent AND Skill content digests, not {}')
    assert.ok(Object.values(digests).every(digest => /^[a-f0-9]{64}$/.test(digest)))
  }
  assert.deepEqual(record.attempts[0].intent.resourceDigests, observed[0], 'TARGET: first Attempt digests survive later resource changes')
  assert.notDeepEqual(observed[0], observed[1], 'TARGET: changed shared tree changes new Attempt evidence')
})

test('C-04 driver-package-freeze: package lib bytes stay frozen for the whole Run', async t => {
  const h = await harness(t)
  const { specs } = await twoResourceAttempts(t, h)
  assert.equal(specs[0].agentMd, 'PACKAGE_AGENT_ORIGINAL')
  assert.equal(specs[1].agentMd, 'PACKAGE_AGENT_ORIGINAL', 'TARGET: second Attempt cannot reread live, edited package lib')
})

test('C-04 control: semantic graph and settled original Attempt survive mutation and request replay', async t => {
  const h = await harness(t)
  let originalAttempt
  const { result, args, specs } = await twoResourceAttempts(t, h, async (_spec, ordinal) => {
    if (ordinal === 2) originalAttempt = structuredClone((await readRuns(h.runtimeRoot))[0].attempts[0])
  })
  const before = await readRun(h, result.runId)
  const replay = await admitAndDrain(h, args)
  const after = await readRun(h, result.runId)
  assert.equal(replay.replayed, true)
  assert.equal(specs.length, 2)
  assert.equal(after.definitionJson, args.definitionJson)
  assert.equal(after.attempts.find(attempt => attempt.nodeId === 'done').state, 'succeeded')
  assert.deepEqual(after.attempts[0], originalAttempt)
  assert.deepEqual(after, before)
})

test('C-05 failure-once: provider failure dispatches once, without 50 blind retries', async t => {
  const h = await harness(
    t,
    registryDouble(turn => turn.finish(PROVIDER_ERROR))
  )
  const result = await admitAndDrain(h, argsFor(h, oneAgent()))
  const record = await readRun(h, result.runId)
  assert.ok(
    record.attempts.every(attempt => attempt.result?.ok === false),
    'control: every observed failure was a real executor typed provider failure'
  )
  assert.equal(h.host.calls.length, 1, 'TARGET: failed root agentTask must not be dispatched 50 times')
  assert.equal(record.attempts.length, 1)
  assert.equal(record.state, 'failed')
})

test('C-05 failure-terminal: provider failure cannot leave the Run running', async t => {
  const h = await harness(
    t,
    registryDouble(turn => turn.finish(PROVIDER_ERROR))
  )
  const result = await admitAndDrain(h, argsFor(h, oneAgent()))
  const record = await readRun(h, result.runId)
  assert.ok(record.attempts.length > 0 && record.attempts[0].result.ok === false)
  assert.equal(record.state, 'failed', 'TARGET: provider failure must eventually reach a Run terminal')
})

test('C-05 unsupported-once: unavailable node is a typed failed Attempt, not 50 attempts', async t => {
  const h = await harness(t)
  const result = await admitAndDrain(h, argsFor(h, definition([{ id: 'unsupported', kind: 'toolCall' }])))
  const record = await readRun(h, result.runId)
  assert.equal(h.host.calls.length, 0)
  assert.match(record.attempts[0].result.evidence, /unavailable/)
  assert.equal(record.attempts.length, 1, 'TARGET: unsupported node has one durable failed dispatch, not blind retries')
  assert.equal(record.state, 'failed')
})

test('C-05 unsupported-terminal: unhandled node leaves an observable failed Run', async t => {
  const h = await harness(t)
  const result = await admitAndDrain(h, argsFor(h, definition([{ id: 'unsupported', kind: 'toolCall' }])))
  const record = await readRun(h, result.runId)
  assert.equal(record.attempts[0].result.ok, false)
  assert.equal(record.state, 'failed', 'TARGET: unsupported node must not strand the Run in running')
})

function decisionDefinition(variant) {
  return definition(
    [
      { id: 'approval', kind: 'humanDecision', ...(variant === 'legacy-branches' ? { branches: ['approve', 'reject'] } : {}) },
      { id: 'approved', kind: 'output' },
      { id: 'rejected', kind: 'output' }
    ],
    [
      { kind: 'control', from: 'approval@approve', to: 'approved' },
      { kind: 'control', from: 'approval@reject', to: 'rejected' }
    ]
  )
}
for (const variant of ['legacy-branches', 'humanDecision']) {
  test(`C-06 humanDecision (${variant} fixture): service admission durably waits for a human decision`, async t => {
    const h = await harness(t)
    const result = await admitAndDrain(h, argsFor(h, decisionDefinition(variant)))
    const record = await readRun(h, result.runId)
    assert.equal(record.state, 'waiting_input', 'TARGET: decision node must eventually wait instead of failing or falling through')
    assert.equal(record.attempts.filter(attempt => attempt.nodeId === 'approval').length, 1)
    assert.ok(['waiting_input', 'running'].includes(record.attempts[0].state))
    assert.equal(record.attempts[0].result, undefined)
  })

  test(`C-06 humanDecision (${variant} fixture): approve settles the waiting Attempt AND resumes only its chosen branch`, async t => {
    const h = await harness(t)
    const start = await admitAndDrain(h, argsFor(h, decisionDefinition(variant)))
    const decisionArgs = { runtimeRoot: h.runtimeRoot, runId: start.runId, decisionId: 'approve-once', action: 'approve' }
    // Both manual fixture variants use humanDecision explicitly. Exercise the
    // real public decision path without an artificial waiting record.
    const approval = await h.service.decide(decisionArgs).then(
      value => ({ value }),
      error => ({ error })
    )
    assert.equal(approval.error?.code, undefined, 'TARGET: a valid waiting decision must be accepted by the public service')
    const decisionSnapshot = await readRun(h, start.runId)
    assert.equal(
      decisionSnapshot.attempts.find(attempt => attempt.nodeId === 'approval').state,
      'succeeded',
      'TARGET: approval must atomically settle the original pending Attempt'
    )
    const record = await eventualRun(h, start.runId, record => record.state === 'succeeded')
    assert.equal(record.attempts.find(attempt => attempt.nodeId === 'approved')?.state, 'succeeded', 'TARGET: selected continuation must actually execute')
    assert.notEqual(record.attempts.find(attempt => attempt.nodeId === 'rejected')?.state, 'succeeded')
    assert.equal(record.state, 'succeeded')
    const beforeReplay = structuredClone(record)
    const replay = await h.service.decide(decisionArgs)
    assert.equal(replay.applied, false)
    assert.deepEqual(await readRun(h, start.runId), beforeReplay, 'TARGET: duplicate approval has no second transition/effect')
  })
}

test('C-06 humanDecision continuation: approve eventually drives the selected branch to a durable terminal', async t => {
  const h = await harness(t)
  const start = await admitAndDrain(h, argsFor(h, decisionDefinition('humanDecision')))
  await h.service.decide({ runtimeRoot: h.runtimeRoot, runId: start.runId, decisionId: 'resume', action: 'approve' })
  const record = await eventualRun(h, start.runId, record => record.state === 'succeeded')
  assert.equal(record.state, 'succeeded', 'TARGET: approved branch must eventually reach a real terminal, not only state=running')
})

test('C-06 control: duplicate decisionId is durably idempotent at the public service', async t => {
  const h = await harness(t)
  const start = await admitAndDrain(h, argsFor(h, decisionDefinition('humanDecision')))
  const args = { runtimeRoot: h.runtimeRoot, runId: start.runId, decisionId: 'stable-decision', action: 'approve' }
  const first = await h.service.decide(args)
  const before = await eventualRun(h, start.runId, record => record.state === 'succeeded')
  const repeated = await h.service.decide(args)
  assert.equal(first.applied, true)
  assert.equal(repeated.applied, false)
  assert.deepEqual(await readRun(h, start.runId), before)
  assert.equal(before.log.filter(event => event.kind === 'decision' && event.detail.decisionId === args.decisionId).length, 1)
})

test('C-05 cancel-controller: service cancel propagates to the in-flight public Agent.cancel', async t => {
  const host = registryDouble(() => {}) // barrier: do not finish until cancel or explicit release
  const h = await harness(t, host)
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const running = h.service.startRun(argsFor(h, oneAgent()))
  const call = await host.started
  const run = (await readRuns(h.runtimeRoot))[0]
  assert.ok(run.attempts[0].intent && !run.attempts[0].result, 'control: cancellation raced a REAL durable in-flight intent')
  let cancelledCalls
  let aborted
  try {
    await h.service.cancelRun({ runtimeRoot: h.runtimeRoot, runId: run.runId })
    for (let observations = 0; observations < 64 && call.cancelCalls.length === 0; observations++) {
      await nextEventLoopTurn()
      await readRun(h, run.runId)
    }
    cancelledCalls = call.cancelCalls.length
    aborted = call.controller.signal.aborted
  } finally {
    // Release even on red so no dangling driver/store is removed underneath it.
    call.finish(PROVIDER_ERROR)
    await finishWithClock(t, running, 100, () => readRuns(h.runtimeRoot))
    h.clockTickMs = 100
    await drainDrivers(h)
  }
  assert.equal(cancelledCalls, 1, 'TARGET: cancellation must reach public Agent.cancel after creation has returned')
  assert.equal(aborted, true, 'TARGET: in-flight operation controller must observe abort')
})

test('C-05 cancel-late-result: a known late result cannot strand the Run in cancelling', async t => {
  const h = await harness(t)
  const entered = deferred()
  const release = deferred()
  executionBoundary(t, async spec => {
    entered.resolve(spec)
    await release.promise
    return completedEvidence(spec, 'CONTROLLED_LATE_RESULT')
  })
  const running = h.service.startRun(argsFor(h, oneAgent()))
  await entered.promise
  const run = (await readRuns(h.runtimeRoot))[0]
  let after
  try {
    const cancel = await h.service.cancelRun({ runtimeRoot: h.runtimeRoot, runId: run.runId })
    assert.ok(['cancelling', 'cancelled', 'recovery_required'].includes(cancel.state))
  } finally {
    release.resolve()
    await running
    after = await eventualRun(h, run.runId, record => record.state === 'cancelled')
  }
  assert.equal(after.state, 'cancelled', 'TARGET: once the in-flight result is known, cancellation must converge, not remain cancelling')
  assert.ok(after.attempts.every(attempt => attempt.result !== undefined || ['cancelled', 'skipped'].includes(attempt.state)))
})

test('C-05 late-result immutability: a settled Attempt cannot have its original result overwritten', async t => {
  const h = await harness(t)
  const opened = await openBlueprintDomain({ backend: 'json', path: join(h.runtimeRoot, 'store') })
  try {
    const store = new RunStore(opened.domain)
    const args = argsFor(h, oneAgent())
    const created = await store.createRun(
      { scope: 'run', requestId: 'late-result', payloadFingerprint: sha256(args.definitionJson) },
      'revision',
      args.definitionJson,
      args.inputJson
    )
    const intent = await store.recordIntent(created.runId, { nodeId: 'work', kind: 'agentTask' })
    await store.recordResult(created.runId, intent.attemptId, {
      ok: false,
      outcome: { kind: 'failed', detail: 'ORIGINAL_RESULT' },
      evidence: 'original-failure'
    })
    const before = await store.get(created.runId)
    // Run intentionally remains running, matching the real store's settlement
    // window; guarding only terminal RUNS must not protect this incorrectly.
    await store
      .recordResult(created.runId, intent.attemptId, { ok: true, outcome: { kind: 'succeeded', detail: 'LATE_RESULT' }, evidence: 'late-overwrite' })
      .catch(error => {
        assert.match(error.code ?? '', /TERMINAL|SETTLED|CONFLICT/, 'TARGET: terminal-attempt rejection must be typed, not an unrelated exception')
      })
    const after = await store.get(created.runId)
    assert.deepEqual(after.attempts[0], before.attempts[0], 'TARGET: late result cannot replace a terminal Attempt state/result')
    assert.equal(after.seq, before.seq, 'TARGET: rejected/ignored duplicate settlement is a durable no-op')
  } finally {
    await opened.close()
  }
})

async function pendingIntentFixture(h) {
  const args = argsFor(h, oneAgent())
  const opened = await openBlueprintDomain({ backend: 'json', path: join(h.runtimeRoot, 'store') })
  try {
    const store = new RunStore(opened.domain)
    const created = await store.createRun(
      { scope: 'run', requestId: 'crashed-intent', payloadFingerprint: sha256(args.definitionJson) },
      'revision',
      args.definitionJson,
      args.inputJson
    )
    const intent = await store.recordIntent(created.runId, { nodeId: 'work', kind: 'agentTask', resourceDigests: { worker: sha256('PACKAGE_AGENT_ORIGINAL') } })
    return { runId: created.runId, attemptId: intent.attemptId }
  } finally {
    await opened.close()
  } // restart boundary: no unsettled result invented
}

test('C-10 restart public service: reopening an unresolved dispatch marks recovery_required without replay', async t => {
  const h = await harness(t)
  const pending = await pendingIntentFixture(h)
  await h.close() // no runtime opened by this service yet; release plugin scope
  const ctx = new Context()
  ctx.provide('agents', h.host.registry)
  const fiber = await ctx.plugin(BlueprintService)
  try {
    const inspection = await ctx.blueprint.inspectRun({ runtimeRoot: h.runtimeRoot, runId: pending.runId })
    assert.equal(h.host.calls.length, 0, 'TARGET: unresolved external effect cannot be blindly replayed after restart')
    let record
    for (let observations = 0; observations < 64; observations++) {
      record = (await readRuns(h.runtimeRoot))[0]
      if (record.state === 'recovery_required') break
      await nextEventLoopTurn()
    }
    assert.equal(record.state, 'recovery_required', 'TARGET: service reopening must eventually reconcile unresolved intent')
    assert.equal(inspection.runId, pending.runId)
    assert.equal(record.attempts.find(attempt => attempt.attemptId === pending.attemptId).state, 'recovery_required')
    assert.equal(record.attempts[0].result, undefined)
  } finally {
    await fiber.dispose()
  }
})

test('C-10 restart reducer: reconcile marks BOTH the Run and its corresponding Attempt recovery_required', async t => {
  const h = await harness(t)
  const pending = await pendingIntentFixture(h)
  const reopened = await openBlueprintDomain({ backend: 'json', path: join(h.runtimeRoot, 'store') })
  try {
    const store = new RunStore(reopened.domain)
    const report = await reconcileOnStart(store)
    const record = await store.get(pending.runId)
    assert.equal(report.recoveryRequired.length, 1)
    assert.equal(record.state, 'recovery_required', 'control: production recovery reducer changed Run state')
    assert.equal(
      record.attempts.find(attempt => attempt.attemptId === pending.attemptId).state,
      'recovery_required',
      'TARGET: reducer must mutate the durable draft Attempt, not an outer read copy'
    )
    assert.equal(record.attempts[0].result, undefined)
    const repeat = await reconcileOnStart(store)
    assert.equal(repeat.recoveryRequired.length, 0)
    assert.deepEqual(await store.get(pending.runId), record, 'TARGET: restart reconciliation is idempotent')
  } finally {
    await reopened.close()
  }
})
