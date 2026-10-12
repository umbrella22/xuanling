/** Source-only W2 failure/race regressions. No suite/report writes, provider, keys or profile. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setImmediate as eventTurn } from 'node:timers/promises'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { BlueprintService } from '../../src/index.ts'
import { BlueprintAgentExecutor, AGENT_CANCEL_QUIESCENCE_MS } from '../../src/host/agent-executor.ts'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'
import { reconcile, reconcileOnStart } from '../../src/orchestration/recovery.ts'
import { decodeDefinition, validateDefinition } from '../../src/definition/index.ts'
import { RuntimeSnapshots } from '../../src/resources/runtime-snapshots.ts'
import { TYPERT } from '../../src/typert.host.ts'

const completed = { kind: 'completed' }
const deferred = () => Promise.withResolvers()
const text = message => message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
function definition(nodes, edges = [], resources = {}) {
  const value = { schemaVersion: 1, id: 'w2-races', name: 'Isolated races', graph: { nodes, edges }, resources }
  validateDefinition(decodeDefinition(JSON.stringify(value)))
  return value
}
const worker = { kind: 'agent', path: 'lib/agents/worker.md' }
const agent = (id = 'work', more = {}) => ({ id, kind: 'agentTask', agentRef: 'worker', ...more })
const oneAgent = () => definition([agent()], [], { worker })
const decisionGraph = () => definition([
  { id: 'review', kind: 'humanDecision' }, agent(), { id: 'unused', kind: 'output' },
], [{ kind: 'control', from: 'review@approve', to: 'work' }, { kind: 'control', from: 'review@reject', to: 'unused' }], { worker })

/** Public shape only, real Session for the canonical terminal reason. */
function publicHost(onDispatch = call => call.finish(completed, 'COMPLETE_RESULT'), cancelSettles = true) {
  const started = deferred()
  const calls = []
  let ownerCtx
  const registry = {
    async create(options) {
      options.signal?.throwIfAborted()
      const id = SessionId(options.sessionId)
      const session = Session.create(id, options.seed, { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), isSeeded: false, ...options.meta }, options.inheritedEventCount)
      const idle = deferred()
      const disposed = deferred()
      let running = false
      const call = {
        options, session, followups: [], cancelCalls: [], disposed: disposed.promise,
        finish(reason, output = '') {
          if (!running) return
          if (output) session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant', content: [{ type: 'text', text: output }] }) }, { surfaceOp: 'append' })
          session.append('turn/end', { turn: 1, reason })
          running = false
          runtime.status = 'idle'
          idle.resolve()
        },
        idleWithoutCloser() { running = false; runtime.status = 'idle'; idle.resolve() },
      }
      const runtime = {
        id: session.id, status: 'idle', session,
        inject() {},
        followup(input) {
          running = true
          runtime.status = 'running'
          session.append('turn/start', { turn: 1 })
          session.append('user/message', input, { surfaceOp: 'append' })
          call.followups.push(text(input))
          started.resolve(call)
          onDispatch(call)
        },
        whenIdle() { return running ? idle.promise : Promise.resolve() },
        cancel(cause) {
          call.cancelCalls.push(cause)
          if (cancelSettles) call.finish({ kind: 'aborted', cause }, 'PARTIAL_ON_CANCEL')
        },
      }
      const scope = createScope(ownerCtx, runtime)
      runtime.ctx = scope.ctx
      try {
        const commit = await options.setup?.(scope.ctx, runtime)
        options.signal?.throwIfAborted()
        commit?.commit()
      } catch (error) { await scope.dispose(); throw error }
      calls.push(call)
      return { agent: runtime, async dispose() { await runtime.whenIdle(); await scope.dispose(); disposed.resolve() } }
    },
  }
  return { registry, calls, started: started.promise, bindOwner(ctx) { ownerCtx = ctx } }
}
async function fixture(t, host = publicHost()) {
  const root = mkdtempSync(join(tmpdir(), 'bp-w2-race-'))
  const rootDir = join(root, 'package')
  const runtimeRoot = join(root, 'runtime')
  mkdirSync(join(rootDir, 'lib', 'agents'), { recursive: true })
  mkdirSync(runtimeRoot)
  writeFileSync(join(rootDir, 'lib', 'agents', 'worker.md'), 'FROZEN_PACKAGE')
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() { return () => {} }, section() { return () => {} }, getSectionOrder() { return 100 } })
  new ToolRuntime(ctx, { mode: 'native' })
  host.bindOwner(ctx)
  ctx.provide('agents', host.registry)
  let fiber = await ctx.plugin(BlueprintService)
  let service = ctx.blueprint
  const args = (value = oneAgent(), more = {}) => ({ definitionJson: JSON.stringify(value), inputJson: '{"task":"ACTUAL_INPUT"}', rootDir, runtimeRoot, requestId: randomUUID(), ...more })
  const handle = () => [...service.runtimes.values()][0]
  const drain = async () => {
    const h = handle()
    while (h?.jobs.size) await Promise.all(h.jobs.values())
    assert.equal(h?.backgroundFailures.size ?? 0, 0, 'driver failures must not disappear behind resolved job promises')
  }
  t.after(async () => { await fiber.dispose(); rmSync(root, { force: true, recursive: true }) })
  return {
    root, rootDir, runtimeRoot, ctx, host, args, handle, drain,
    get service() { return service },
    run: async id => await handle().store.get(id),
    async restart() { await fiber.dispose(); fiber = await ctx.plugin(BlueprintService); service = ctx.blueprint },
  }
}
const direct = h => ({ runId: 'direct', attemptId: 'direct', nodeId: 'work', cwd: h.rootDir, agentMd: '', skills: [], input: 'REAL', timeoutMs: 2_000 })

for (const backend of ['json', 'sqlite']) {
  for (const action of ['succeeded', 'failed', 'cancelled', 'timed_out']) {
    test(`recovery ${backend}: reviewed ${action} atomically matches Attempt and Run, survives reopen`, async t => {
      const root = mkdtempSync(join(tmpdir(), 'bp-w2-reconcile-'))
      const spec = { backend, path: join(root, backend === 'sqlite' ? 'runs.sqlite' : 'store') }
      let opened = await openBlueprintDomain(spec)
      t.after(async () => { await opened.close(); rmSync(root, { recursive: true, force: true }) })
      const store = new RunStore(opened.domain)
      const created = await store.createRun({ scope: 'recovery', requestId: 'review', payloadFingerprint: 'same' }, 'revision', JSON.stringify(oneAgent()), '{}')
      const intent = await store.recordIntent(created.runId, { nodeId: 'work', kind: 'agentTask', resourceDigests: { worker: 'a'.repeat(64) } })
      await reconcileOnStart(store)
      const unknown = await store.get(created.runId)
      assert.equal(unknown.state, 'recovery_required')
      assert.equal(unknown.attempts[0].state, 'recovery_required')
      const result = await reconcile(store, unknown, action, 'operator-reviewed-isolated-evidence')
      assert.equal(result.seq, unknown.seq + 1, 'one aggregate commit, no intermediate failed Attempt')
      assert.equal(result.state, action)
      assert.equal(result.attempts[0].state, action)
      assert.equal(result.attempts[0].attemptId, intent.attemptId)
      assert.deepEqual(result.attempts[0].intent, unknown.attempts[0].intent)
      assert.equal(result.attempts[0].result.ok, action === 'succeeded')
      await assert.rejects(store.recordResult(created.runId, intent.attemptId, { ok: true, outcome: { kind: 'succeeded' }, evidence: 'late' }), { code: 'TERMINAL_STATE_IMMUTABLE' })
      await opened.close()
      opened = await openBlueprintDomain(spec)
      const reopened = new RunStore(opened.domain)
      const before = await reopened.get(created.runId)
      assert.deepEqual(before, result)
      await reconcileOnStart(reopened)
      assert.deepEqual(await reopened.get(created.runId), before, 'startup does not rewrite terminal facts')
    })
  }
  test(`store ${backend}: simultaneous duplicate admission and competing results serialize`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'bp-w2-store-race-'))
    const opened = await openBlueprintDomain({ backend, path: join(root, backend === 'sqlite' ? 'runs.sqlite' : 'store') })
    t.after(async () => { await opened.close(); rmSync(root, { recursive: true, force: true }) })
    const store = new RunStore(opened.domain)
    const request = { scope: 'start', requestId: 'same', payloadFingerprint: 'payload' }
    const results = await Promise.all(Array.from({ length: 6 }, () => store.createRun(request, 'revision', '{}', '{}')))
    assert.equal(new Set(results.map(r => r.runId)).size, 1)
    assert.equal(results.filter(r => !r.replayed).length, 1)
    const runId = results[0].runId
    const intent = await store.recordIntent(runId, { nodeId: 'node', kind: 'input' })
    const first = { ok: true, outcome: { outputs: { text: 'FIRST' } }, evidence: 'first' }
    const raced = await Promise.allSettled([
      store.recordResult(runId, intent.attemptId, first),
      store.recordResult(runId, intent.attemptId, { ok: false, outcome: { kind: 'failed' }, evidence: 'second' }),
    ])
    assert.equal(raced[0].status, 'fulfilled')
    assert.equal(raced[1].reason.code, 'ATTEMPT_SETTLED_CONFLICT')
    assert.deepEqual((await store.get(runId)).attempts[0].result.outcome, first.outcome)
    await assert.rejects(store.recordIntent(runId, { nodeId: 'node', kind: 'input' }), { code: 'ATTEMPT_SETTLED_CONFLICT' })
  })
}

test('service: concurrent first open, path alias, duplicate admission yield one writer and one dispatch', async t => {
  const h = await fixture(t)
  const alias = join(h.root, 'runtime-alias')
  symlinkSync(h.runtimeRoot, alias, 'dir')
  const args = h.args()
  const results = await Promise.all([h.service.startRun(args), h.service.startRun({ ...args, runtimeRoot: alias }), h.service.inspectRun({ runtimeRoot: alias, runId: 'nonexistent' }).catch(error => error)])
  assert.equal(results[0].runId, results[1].runId)
  assert.equal(results[0].replayed, false)
  assert.equal(results[1].replayed, true)
  assert.equal(results[2].code, 'blueprint/run-not-found')
  await h.drain()
  assert.equal(h.service.runtimes.size, 1)
  assert.equal(h.host.calls.length, 1)
  assert.equal((await h.run(results[0].runId)).state, 'succeeded')
})

test('service: competing decisions are idempotent by Attempt result, conflicting action rejected', async t => {
  const h = await fixture(t)
  const admitted = await h.service.startRun(h.args(decisionGraph()))
  await h.drain()
  const args = { runId: admitted.runId, runtimeRoot: h.runtimeRoot, decisionId: 'one-decision', action: 'approve' }
  const results = await Promise.all([h.service.decide(args), h.service.decide(args), h.service.decide({ ...args, action: 'reject' }).catch(error => error)])
  assert.deepEqual(results.slice(0, 2).map(r => r.applied), [true, false])
  assert.equal(results[2].code, 'blueprint/decision-invalid')
  await h.drain()
  const run = await h.run(admitted.runId)
  assert.equal(run.state, 'succeeded')
  assert.equal(run.attempts.find(a => a.nodeId === 'review').result.outcome.branch, 'approve')
  assert.equal(run.attempts.find(a => a.nodeId === 'unused').state, 'skipped')
  assert.equal(h.host.calls.length, 1)
  // Canonical dedup remains valid even after the bounded log has dropped the entry.
  assert.equal((await h.service.decide(args)).applied, false)
  await assert.rejects(h.service.decide({ ...args, decisionId: 'different' }), { code: 'blueprint/decision-invalid' })
})

test('service: decision admitted before previous waiting driver drains still schedules continuation', async t => {
  const h = await fixture(t)
  await h.service.runtimeFor(h.runtimeRoot)
  const store = h.handle().store
  const persisted = deferred()
  const release = deferred()
  const transition = store.transition.bind(store)
  t.mock.method(store, 'transition', async (...args) => {
    const run = await transition(...args)
    if (run.state === 'waiting_input') { persisted.resolve(run); await release.promise }
    return run
  })
  const start = await h.service.startRun(h.args(decisionGraph()))
  await persisted.promise
  try {
    assert.equal((await h.service.decide({ runId: start.runId, runtimeRoot: h.runtimeRoot, decisionId: 'early', action: 'approve' })).applied, true)
  } finally { release.resolve() }
  await h.drain()
  assert.equal((await h.run(start.runId)).state, 'succeeded')
  assert.equal(h.host.calls.length, 1)
})

test('service: restart waiting decision uses frozen package, fresh shared closure only on new Attempt', async t => {
  const h = await fixture(t)
  const shared = join(h.root, 'shared', 'review')
  mkdirSync(join(shared, 'scripts'), { recursive: true })
  writeFileSync(join(shared, 'SKILL.md'), 'BEFORE_RESTART')
  writeFileSync(join(shared, 'scripts', 'helper.mjs'), 'BEFORE_SCRIPT')
  writeFileSync(join(h.runtimeRoot, 'root-bindings.json'), JSON.stringify({ roots: [{ rootId: 'isolated', rootPath: dirname(shared) }] }))
  const value = decisionGraph()
  value.graph.nodes.find(n => n.id === 'work').skillRefs = ['shared']
  value.resources.shared = { kind: 'skill', source: { kind: 'shared', rootId: 'isolated', path: 'review' } }
  const admitted = await h.service.startRun(h.args(value))
  await h.drain()
  assert.equal((await h.run(admitted.runId)).state, 'waiting_input')
  await h.restart()
  writeFileSync(join(h.rootDir, 'lib', 'agents', 'worker.md'), 'LIVE_PACKAGE_CHANGED')
  writeFileSync(join(shared, 'SKILL.md'), 'AFTER_RESTART')
  writeFileSync(join(shared, 'scripts', 'helper.mjs'), 'AFTER_SCRIPT')
  const specs = []
  t.mock.method(BlueprintAgentExecutor.prototype, 'execute', async spec => {
    specs.push(spec)
    const path = join(spec.cwd, '.blueprint-skills', '0', 'scripts', 'helper.mjs')
    assert.equal(readFileSync(path, 'utf8'), 'AFTER_SCRIPT')
    return { sessionId: 'isolated', agentCreated: true, scopedInjections: [], inboxSplicedSeen: true, outcome: { ok: true, kind: 'succeeded', detail: 'complete' } }
  })
  await h.service.decide({ runId: admitted.runId, runtimeRoot: h.runtimeRoot, decisionId: 'after-restart', action: 'approve' })
  await h.drain()
  assert.equal((await h.run(admitted.runId)).state, 'succeeded')
  assert.equal(specs.length, 1)
  assert.equal(specs[0].agentMd, 'FROZEN_PACKAGE')
  assert.match(specs[0].skills[0].content, /AFTER_RESTART/)
})

test('executor: pre-abort has no creation or dispatch; in-flight abort invokes public cancel once', async t => {
  const host = publicHost(() => {})
  const h = await fixture(t, host)
  const controller = new AbortController()
  controller.abort()
  const executor = new BlueprintAgentExecutor(h.ctx, host.registry)
  assert.equal((await executor.execute({ ...direct(h), signal: controller.signal })).outcome.kind, 'cancelled')
  assert.equal(host.calls.length, 0)
  const live = new AbortController()
  const result = executor.execute({ ...direct(h), signal: live.signal })
  const call = await host.started
  live.abort(); live.abort()
  const evidence = await result
  assert.equal(evidence.outcome.kind, 'cancelled')
  assert.equal(call.cancelCalls.length, 1)
  await call.disposed
})

test('executor: cancellation while creating returns without followup, observes create signal', async t => {
  const host = publicHost()
  const entered = deferred()
  host.registry.create = options => {
    entered.resolve(options)
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('RAW_CREATION_SECRET')), { once: true }))
  }
  const h = await fixture(t, host)
  const controller = new AbortController()
  const result = new BlueprintAgentExecutor(h.ctx, host.registry).execute({ ...direct(h), signal: controller.signal })
  const options = await entered.promise
  controller.abort()
  const evidence = await result
  assert.equal(options.signal.aborted, true)
  assert.equal(evidence.outcome.kind, 'cancelled')
  assert.equal(evidence.agentCreated, false)
  assert.equal(host.calls.length, 0)
  assert.doesNotMatch(JSON.stringify(evidence), /RAW_CREATION_SECRET/)
})

test('executor: creation deadline is bounded and late public handle is disposed without dispatch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = publicHost()
  const original = host.registry.create
  const entered = deferred()
  const publication = deferred()
  host.registry.create = async options => {
    entered.resolve(options)
    await publication.promise // deliberately uncooperative creation, no followup
    const { signal: _signal, ...rest } = options
    return await original(rest)
  }
  const h = await fixture(t, host)
  const result = new BlueprintAgentExecutor(h.ctx, host.registry).execute(direct(h))
  await entered.promise
  t.mock.timers.tick(2_000)
  const evidence = await result
  assert.equal(evidence.outcome.kind, 'timeout')
  publication.resolve()
  await eventTurn()
  assert.equal(host.calls.length, 1)
  await host.calls[0].disposed
  assert.deepEqual(host.calls[0].followups, [])
})

for (const mode of ['idle-no-end', 'prior-completed']) {
  test(`executor: ${mode} cannot counterfeit this dispatch's successful durable turn`, async t => {
    const host = publicHost(call => call.idleWithoutCloser())
    const create = host.registry.create
    if (mode === 'prior-completed') host.registry.create = async options => {
      const handle = await create(options)
      handle.agent.session.append('turn/start', { turn: 0 })
      handle.agent.session.append('turn/end', { turn: 0, reason: completed })
      return handle
    }
    const h = await fixture(t, host)
    const evidence = await new BlueprintAgentExecutor(h.ctx, host.registry).execute(direct(h))
    assert.equal(evidence.outcome.ok, false)
    assert.equal(evidence.outcome.kind, 'recovery_required')
    await host.calls[0].disposed
  })
}

test('service: cancellation with unknown quiescence persists Run AND Attempt recovery, no fabricated result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = publicHost(() => {}, false)
  const h = await fixture(t, host)
  const start = await h.service.startRun(h.args())
  const call = await host.started
  await h.service.cancelRun({ runId: start.runId, runtimeRoot: h.runtimeRoot })
  t.mock.timers.tick(AGENT_CANCEL_QUIESCENCE_MS)
  await h.drain()
  const run = await h.run(start.runId)
  assert.equal(call.cancelCalls.length, 1)
  assert.equal(run.state, 'recovery_required')
  assert.equal(run.attempts[0].state, 'recovery_required')
  assert.equal(run.attempts[0].result, undefined)
  assert.ok(existsSync(call.options.meta.cwd), 'unknown effect retains cwd')
  call.finish({ kind: 'aborted', cause: { kind: 'parent' } })
  await call.disposed
  await h.restart()
  await h.service.inspectRun({ runId: start.runId, runtimeRoot: h.runtimeRoot })
  assert.deepEqual(await h.run(start.runId), run, 'same Attempt is not reread/replayed or auto-success on restart')
  assert.equal(host.calls.length, 1)
})

for (const mode of ['aborted', 'unknown']) {
  test(`hostProbe: ${mode} remains explicit failure accepted by existing wire codec`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const host = publicHost(mode === 'aborted' ? call => call.finish({ kind: 'aborted', cause: { kind: 'parent' } }) : () => {}, false)
    const h = await fixture(t, host)
    const skillDir = join(h.root, 'probe-skill')
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), 'ISOLATED_NO_KEY_SKILL')
    const result = h.service.hostProbe({ skillDir, input: 'real input' })
    const call = await host.started
    if (mode === 'unknown') {
      let settled = false
      void result.then(() => { settled = true })
      t.mock.timers.tick(20_000)
      await eventTurn()
      assert.equal(settled, false, 'hostProbe has no default execution deadline')
      assert.deepEqual(call.cancelCalls, [], 'elapsed time alone must not cancel the native operation')
      // Native idle without turn/end is an unknown terminal fact. The fixture
      // reports it explicitly; uncooperative cancellation is covered above.
      call.idleWithoutCloser()
    }
    const evidence = await result
    const codec = TYPERT.invocations.find(i => i.method === 'hostProbe').result.create()
    assert.deepEqual(codec.parse(evidence), evidence)
    assert.equal(evidence.outcome.ok, false)
    assert.equal(evidence.outcome.kind, 'failed')
    assert.match(evidence.outcome.detail, mode === 'aborted' ? /cancelled/ : /recovery_required/)
    if (mode === 'unknown') {
      assert.ok(existsSync(call.options.meta.cwd))
      call.finish({ kind: 'aborted', cause: { kind: 'parent' } })
      await call.disposed
      rmSync(call.options.meta.cwd, { recursive: true, force: true })
    }
  })
}

for (const escape of ['file', 'directory', 'lib-root']) {
  test(`resources: ${escape} symlink escape fails before any public dispatch, no secret fixture`, async t => {
    const h = await fixture(t)
    const outside = join(h.root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'harmless.txt'), 'HARMLESS_OUTSIDE_SENTINEL')
    if (escape === 'lib-root') {
      rmSync(join(h.rootDir, 'lib'), { recursive: true })
      symlinkSync(outside, join(h.rootDir, 'lib'), 'dir')
    } else symlinkSync(escape === 'file' ? join(outside, 'harmless.txt') : outside, join(h.rootDir, 'lib', 'escape'), escape === 'file' ? 'file' : 'dir')
    await assert.rejects(h.service.startRun(h.args()), { code: 'blueprint/durability-failed' })
    await h.drain()
    const ids = await h.handle().store.listRunIds()
    const run = await h.run(ids[0])
    assert.equal(run.state, 'failed')
    assert.deepEqual(run.attempts, [])
    assert.equal(h.host.calls.length, 0)
    assert.doesNotMatch(JSON.stringify(run), /HARMLESS_OUTSIDE_SENTINEL/)
  })
}

test('resources: internal symlink directory materializes complete bytes without links', async t => {
  const h = await fixture(t)
  mkdirSync(join(h.rootDir, 'lib', 'assets'))
  writeFileSync(join(h.rootDir, 'lib', 'assets', 'data.bin'), Buffer.from([0, 5, 255]))
  symlinkSync(join(h.rootDir, 'lib', 'assets'), join(h.rootDir, 'lib', 'alias'), 'dir')
  const snapshots = new RuntimeSnapshots(h.runtimeRoot)
  await snapshots.freezePackage('internal-link', oneAgent(), h.rootDir)
  const prepared = await snapshots.prepare('internal-link', oneAgent(), agent())
  const cwd = prepared.materialize('one')
  assert.deepEqual(readFileSync(join(cwd, 'lib', 'alias', 'data.bin')), Buffer.from([0, 5, 255]))
})

test('restart: corrupt frozen manifest fails before dispatch and durably settles failed', async t => {
  const h = await fixture(t)
  const start = await h.service.startRun(h.args(decisionGraph()))
  await h.drain()
  await h.restart()
  const path = join(h.runtimeRoot, 'snapshots', start.runId, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  manifest.files[0].base64 = Buffer.from('TAMPERED_BYTES').toString('base64')
  writeFileSync(path, JSON.stringify(manifest))
  await h.service.decide({ runId: start.runId, runtimeRoot: h.runtimeRoot, decisionId: 'tampered', action: 'approve' })
  await h.drain()
  const run = await h.run(start.runId)
  assert.equal(run.state, 'failed')
  assert.equal(run.attempts.filter(a => a.nodeId === 'work').length, 0)
  assert.equal(h.host.calls.length, 0)
  assert.doesNotMatch(JSON.stringify(run), /TAMPERED_BYTES/)
})

test('driver: raw provider/creation failure never enters Run evidence or wire error', async t => {
  const secret = 'RAW_PROVIDER_TOKEN_NOT_A_REAL_KEY'
  const host = publicHost(call => call.finish({ kind: 'error', error: { code: 'UNKNOWN', message: secret } }))
  const h = await fixture(t, host)
  const first = await h.service.startRun(h.args())
  await h.drain()
  assert.equal((await h.run(first.runId)).state, 'failed')
  assert.doesNotMatch(JSON.stringify(await h.run(first.runId)), /RAW_PROVIDER_TOKEN_NOT_A_REAL_KEY/)
  host.registry.create = async () => { throw new Error(secret) }
  const second = await h.service.startRun(h.args())
  await h.drain()
  const run = await h.run(second.runId)
  assert.equal(run.state, 'failed')
  assert.equal(run.attempts.length, 1)
  assert.doesNotMatch(JSON.stringify(run), /RAW_PROVIDER_TOKEN_NOT_A_REAL_KEY/)
})

test('service: driver write failure is caught, persisted recovery when later storage commits succeed', async t => {
  const h = await fixture(t)
  await h.service.runtimeFor(h.runtimeRoot)
  const store = h.handle().store
  const original = store.recordResult.bind(store)
  let first = true
  t.mock.method(store, 'recordResult', async (...args) => {
    if (first) { first = false; const { DurabilityFailureError } = await import('../../src/persistence/index.ts'); throw new DurabilityFailureError('isolated-fault', new Error('RAW_STORAGE_BODY')) }
    return await original(...args)
  })
  const start = await h.service.startRun(h.args())
  await h.drain()
  const run = await h.run(start.runId)
  assert.equal(run.state, 'recovery_required')
  assert.equal(run.attempts[0].state, 'recovery_required')
  assert.equal(run.attempts[0].result, undefined)
  assert.equal(h.host.calls.length, 1)
  assert.doesNotMatch(JSON.stringify(run), /RAW_STORAGE_BODY/)
})

test('service: cancel during creation reaches creation signal and settles both known cancelled facts', async t => {
  const host = publicHost()
  const entered = deferred()
  host.registry.create = options => {
    entered.resolve(options)
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('ISOLATED_CREATE_ABORT')), { once: true }))
  }
  const h = await fixture(t, host)
  const start = await h.service.startRun(h.args())
  const options = await entered.promise
  await h.service.cancelRun({ runId: start.runId, runtimeRoot: h.runtimeRoot })
  await h.drain()
  const run = await h.run(start.runId)
  assert.equal(options.signal.aborted, true)
  assert.equal(run.state, 'cancelled')
  assert.equal(run.attempts[0].state, 'cancelled')
  assert.equal(run.attempts[0].result.outcome.kind, 'cancelled')
  assert.equal(host.calls.length, 0)
})

test('service: cancellation before intent/creation does not publish or dispatch a new Attempt', async t => {
  const h = await fixture(t)
  const entered = deferred()
  const release = deferred()
  const prepare = RuntimeSnapshots.prototype.prepare
  t.mock.method(RuntimeSnapshots.prototype, 'prepare', async function (...args) {
    const prepared = await prepare.apply(this, args)
    entered.resolve()
    await release.promise
    return prepared
  })
  const start = await h.service.startRun(h.args())
  await entered.promise
  try { assert.equal((await h.service.cancelRun({ runId: start.runId, runtimeRoot: h.runtimeRoot })).state, 'cancelled') }
  finally { release.resolve() }
  await h.drain()
  assert.equal((await h.run(start.runId)).state, 'cancelled')
  assert.equal((await h.run(start.runId)).attempts.length, 0)
  assert.equal(h.host.calls.length, 0)
})

test('service: persistent settlement failure yields typed unavailable inspection, never unhandled job rejection', async t => {
  const h = await fixture(t)
  await h.service.runtimeFor(h.runtimeRoot)
  const store = h.handle().store
  const { DurabilityFailureError } = await import('../../src/persistence/index.ts')
  t.mock.method(store, 'recordResult', async () => { throw new DurabilityFailureError('isolated-result', 'RAW_SECRET_STORAGE_CAUSE') })
  t.mock.method(store, 'settleTerminal', async () => { throw new DurabilityFailureError('isolated-settle', 'RAW_SECRET_STORAGE_CAUSE') })
  const start = await h.service.startRun(h.args())
  await Promise.all(h.handle().jobs.values())
  assert.equal(h.handle().backgroundFailures.size, 1)
  await assert.rejects(h.service.inspectRun({ runtimeRoot: h.runtimeRoot, runId: start.runId }), error => {
    assert.equal(error.code, 'blueprint/durability-failed')
    assert.doesNotMatch(error.message, /RAW_SECRET_STORAGE_CAUSE/)
    return true
  })
  const record = await h.run(start.runId)
  assert.equal(record.attempts[0].result, undefined, 'cannot fabricate durability during failing medium')
  await h.restart()
  await h.service.inspectRun({ runtimeRoot: h.runtimeRoot, runId: start.runId })
  const recovered = await h.run(start.runId)
  assert.equal(recovered.state, 'recovery_required')
  assert.equal(recovered.attempts[0].state, 'recovery_required')
})

test('hostProbe: synchronous composition error is typed and never echoes raw provider secret', async t => {
  const host = publicHost()
  host.registry.create = () => { throw new Error('SYNCHRONOUS_RAW_SECRET') }
  const h = await fixture(t, host)
  const skillDir = join(h.root, 'skill')
  mkdirSync(skillDir)
  writeFileSync(join(skillDir, 'SKILL.md'), 'ISOLATED')
  await assert.rejects(h.service.hostProbe({ skillDir, input: 'input' }), error => {
    assert.equal(error.code, 'AGENT_COMPOSITION_UNSUPPORTED')
    assert.doesNotMatch(error.message, /SYNCHRONOUS_RAW_SECRET/)
    return true
  })
})
