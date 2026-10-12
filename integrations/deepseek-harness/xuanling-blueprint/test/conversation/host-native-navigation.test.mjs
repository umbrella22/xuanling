import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, readFileSync, readdirSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import SubagentRuntime, { foldSubagentDescriptor, SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { BlueprintService } from '../../src/index.ts'
import { BlueprintAgentExecutor, AGENT_CANCEL_QUIESCENCE_MS } from '../../src/host/agent-executor.ts'
import { harness, definition, runArgs, drain, records, OUTPUT, directSpec, provideFixtureWorkingDirectory } from '../runtime-contracts/agent-fixtures.mjs'

class PointQuery extends SessionQuery {
  searchSessions() { throw new Error('search not used by native navigation oracle') }
  searchEvents() { throw new Error('search not used by native navigation oracle') }
}
const signal = () => new AbortController().signal
const errorCode = code => error => error.code === code

/** File-backed public persistence/read seam. Real Session, query, projection
 * and API code interpret these facts; no headers or descriptors are added by
 * this fixture. This is a test storage participant, not the native JSONL backend. */
function journal(ctx, root) {
  mkdirSync(root, { recursive: true })
  const file = id => join(root, `${encodeURIComponent(id)}.json`)
  const read = id => existsSync(file(id)) ? JSON.parse(readFileSync(file(id), 'utf8')) : undefined
  const controls = { beforeFlush: undefined, flushes: [] }
  ctx.provide('sessionPersistence', {
    identity: Symbol('navigation-journal'),
    async stat(id, options) { options?.signal?.throwIfAborted(); const data = read(id)
      return data && { header: data.header, revision: String(data.events.length) } },
    async list() { return readdirSync(root).map(name => JSON.parse(readFileSync(join(root, name), 'utf8')))
      .map(data => ({ header: data.header, revision: String(data.events.length) })) },
    async open(id, access, options) {
      options?.signal?.throwIfAborted(); assert.equal(access, 'read'); const data = read(id); assert.ok(data)
      return { id, access, header: data.header, inheritedEventCount: data.inheritedEventCount,
        async read(offset = 0, length, options) { options?.signal?.throwIfAborted()
          return { eventState: 'detached', events: structuredClone(data.events.slice(offset, length === undefined ? undefined : offset + length)) } },
        async close() {}, async [Symbol.asyncDispose]() {},
      }
    },
  })
  ctx.on('session/flush', async session => {
    controls.flushes.push({ sessionId: session.id, types: session.snapshotEvents().map(event => event.type) })
    await controls.beforeFlush?.(session)
    const fd = openSync(file(session.id), 'w')
    try { writeFileSync(fd, JSON.stringify({ header: session.header, inheritedEventCount: session.inheritedEventCount,
      events: session.snapshotEvents() })); fsyncSync(fd) } finally { closeSync(fd) }
  }, { global: true })
  return { ...controls, read, controls, root }
}

async function nativeServices(ctx, defaultDirectory) {
  if (ctx.get('workingDirectory') === undefined) provideFixtureWorkingDirectory(ctx, defaultDirectory)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjections)
  new PointQuery(ctx)
  ctx.provide('typert', { lookups: { configure: () => () => {} }, contexts: { configureHost: () => () => {} } })
  await ctx.plugin(SubagentRuntime, {})
  assert.ok(ctx.get('subagents'), 'alpha.2 runtime must activate before querying its native projections')
  ctx.provide('fileUploads', { registerAgentResolver: () => () => {} })
  ctx.provide('attachments', { imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 10,
    maxMessageImageBytes: 10240, maxImagePixels: 100000, maxImageDimension: 1000, mediaTypes: ['image/png'] } })
  return new SessionController(ctx, { nativeOpen: false })
}

async function navigationHarness(t, { beforeModel, onModel = call => call.finish(), ...options } = {}) {
  let modelCalls = 0
  const runtimeFaults = []
  const h = await harness(t, { ...options, factory: false, onTurn: async call => {
    const stepSignal = new AbortController()
    const abort = () => stepSignal.abort()
    call.options.signal.addEventListener('abort', abort, { once: true })
    if (call.options.signal.aborted) abort()
    try {
      await beforeModel?.(call)
      const decision = await agentEvents(call.agent.ctx, call.agent).waterfall('agent/pre-step',
        { messages: [{}], turn: 1, step: 1, signal: stepSignal.signal },
        async () => ({ kind: 'enter', messages: [{}] }))
      if (stepSignal.signal.aborted || decision.kind !== 'enter') return
      modelCalls++
      await onModel(call)
    } catch (error) {
      runtimeFaults.push(error)
      call.finish({ kind: 'error', error: { code: 'UNKNOWN', message: 'controlled runtime step failed' } }, '')
    } finally { call.options.signal.removeEventListener('abort', abort) }
  } })
  const controller = await nativeServices(h.ctx, h.rootDir)
  const storage = journal(h.ctx, join(h.root, 'native-session-journal'))
  const factoryControls = { beforeCreate: undefined, afterCreate: undefined, beforeDispose: undefined }
  const detachers = [], factoryErrors = []
  const create = h.host.registry.create.bind(h.host.registry)
  t.mock.method(h.ctx.agents, 'create', async options => {
    try {
    await factoryControls.beforeCreate?.(options)
    const handle = await create(options)
    const child = handle.agent
    const call = h.host.calls.at(-1), finish = call.finish.bind(call)
    // This native replay fixture supplies the public LLM source contract at
    // the scripted model boundary; the older unrelated fixtures stay untouched.
    call.finish = (reason = { kind: 'completed' }, text = OUTPUT) => {
      if (child.status === 'running' && text) child.session.append('assistant/message', {
        turn: 1, step: 1, stream: [], message: createAssistantMessage({
          content: [{ type: 'text', text }], source: { provider: 'navigation-fixture', model: 'navigation-fixture' },
        }),
      }, { surfaceOp: 'append' })
      finish(reason, '')
    }
    const leaveSession = child.ctx.get('sessions').enter(child.session)
    const leaveAgent = h.ctx.agents.enter(child, options.parentAgent)
    child.ctx.get('sessions').announce(child.session)
    await h.ctx.agents.announce(child, 'startup', options.signal)
    const dispose = handle.dispose.bind(handle)
    handle.dispose = async () => {
      await factoryControls.beforeDispose?.(child)
      await child.ctx.get('sessions').flush(child.session)
      await dispose(); leaveAgent(); leaveSession()
    }
    detachers.push(() => { leaveAgent(); leaveSession() })
    await factoryControls.afterCreate?.(handle)
    return handle
    } catch (error) { factoryErrors.push(error); throw error }
  })
  const session = h.ctx.sessions.create(SessionId('navigation-source'), { meta: { cwd: h.rootDir } })
  const parent = { id: session.id, session, status: 'idle', whenIdle: async () => {}, cancel() {} }
  const scope = createScope(h.ctx, parent); parent.ctx = scope.ctx
  const leaveParent = h.ctx.agents.enter(parent, undefined)
  await h.ctx.agents.announce(parent, 'startup')
  t.after(async () => { for (const detach of detachers) detach(); leaveParent(); await scope.dispose() })
  const page = (address, session) => controller.page({ address, throughSeq: session.seq - 1 }, signal())
  const address = child => ({ kind: 'subagent', parentSessionId: parent.id, childSessionId: child.id, mode: 'one-shot' })
  return { ...h, parent, controller, page, address, factoryErrors, runtimeFaults, storage, factoryControls,
    leaveParent, disposeParent: async () => { leaveParent(); await scope.dispose() }, modelCalls: () => modelCalls }
}

test('host native navigation: sourced production AgentTask is readable by public session/page with its native child address', async t => {
  let routeResult, ordinaryError
  const h = await navigationHarness(t, { onModel: async call => {
    ordinaryError = await h.page({ kind: 'session', sessionId: call.session.id }, call.session).catch(error => error)
    routeResult = await h.page(h.address(call.session), call.session).then(value => ({ value }), error => ({ error }))
    call.finish()
  } })
  const doc = await h.save(definition())
  await h.service.startSessionRun({ ...runArgs(doc), sessionId: h.parent.id })
  await drain(h)
  assert.deepEqual(h.factoryErrors, [])
  const child = h.host.calls[0].session
  assert.equal(ordinaryError.code, 'session/agent-busy')
  if (routeResult.error) throw routeResult.error
  const page = routeResult.value
  assert.ok(page.records.some(record => record.type === 'event' && record.event.type === 'subagent/descriptor'))
  assert.ok(child.snapshotEvents().some(event => event.type === 'assistant/message' && JSON.stringify(event).includes(OUTPUT)))
  assert.equal(h.modelCalls(), 1)
  assert.equal((await records(h))[0].attempts[0].sessionId, child.id)
  assert.deepEqual(h.runtimeFaults, [])
})

test('host native navigation: sourced child appears in the real parent catalog projection and own descriptor projection', async t => {
  let projection, own
  const h = await navigationHarness(t, { onModel: async call => {
    projection = await h.controller.projections({ sessionId: h.parent.id }, signal())
    own = await h.controller.projections({ sessionId: call.session.id }, signal())
    call.finish()
  } })
  const doc = await h.save(definition())
  await h.service.startSessionRun({ ...runArgs(doc), sessionId: h.parent.id })
  await drain(h)
  assert.deepEqual(h.factoryErrors, [])
  const child = h.host.calls[0].session
  assert.deepEqual(projection.values.subagentCatalog, [{ id: child.id, createdAt: child.header.createdAt, mode: 'one-shot' }])
  assert.equal(child.header.parentSession, h.parent.id)
  assert.equal(own.values.subagent.mode, 'one-shot')
  assert.ok(own.values.subagent.seq >= child.inheritedEventCount)
})

async function boundedSettlement(promise) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('native lineage settlement exceeded the existing cancellation quiescence budget')),
      AGENT_CANCEL_QUIESCENCE_MS + 500)
  })]) } finally { clearTimeout(timer) }
}

test('host native navigation: cancelled never-settling public catalog flush is bounded and never sends late followup', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const h = await navigationHarness(t)
  h.storage.controls.beforeFlush = async session => {
    if (session === h.parent.session) { entered.resolve(); await release.promise }
  }
  const doc = await h.save(definition())
  const started = await h.service.startSessionRun({ ...runArgs(doc), sessionId: h.parent.id })
  await entered.promise
  const runtime = await h.service.configuredRuntime()
  const job = runtime.jobs.get(started.runId)
  await h.service.cancelRun({ runId: started.runId })
  try {
    await boundedSettlement(job)
    const saved = await runtime.store.get(started.runId)
    assert.equal(saved.state, 'cancelled')
    assert.equal(h.modelCalls(), 0)
    assert.equal(h.host.calls[0].session.snapshotEvents().some(event => event.type === 'turn/start'), false)
    assert.equal(h.parent.session.snapshotEvents().filter(event => event.type === 'subagent/catalog').length, 1,
      'an appended but unconfirmed catalog fact is retained')
  } finally { release.resolve(); await job }
  await drain(h)
  assert.equal(h.modelCalls(), 0)
  assert.equal(h.storage.read(h.parent.id).events.filter(event => event.type === 'subagent/catalog').length, 1)
})

test('host native navigation: header, catalog and initial-turn descriptor are flushed before the first model and descriptor is one-shot', async t => {
  const h = await navigationHarness(t, { onModel: async call => {
    const child = h.storage.read(call.session.id)
    const parent = h.storage.read(h.parent.id)
    assert.equal(child.header.parentSession, h.parent.id)
    assert.equal(parent.events.filter(event => event.type === 'subagent/catalog')[0].data.childId, call.session.id)
    const index = child.events.findIndex(event => event.type === 'subagent/descriptor')
    assert.ok(index > child.events.findIndex(event => event.type === 'turn/start'))
    assert.equal(child.events[index].surfaceOp, undefined)
    assert.deepEqual(child.events[index].data, { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'one-shot', provider: 'xuanling-blueprint' })
    assert.deepEqual(foldSubagentDescriptor(child.events.slice(child.inheritedEventCount)), child.events[index].data,
      'actual alpha.2 fold must accept the production one-shot payload without continuable composition fields')
    assert.equal(Object.hasOwn(child.events[index].data, 'label'), false, 'one-shot label omission must survive JSON persistence')
    await agentEvents(call.agent.ctx, call.agent).waterfall('agent/pre-step',
      { messages: [{}], turn: 1, step: 2, signal: signal() }, async () => ({ kind: 'enter', messages: [{}] }))
    assert.equal(call.session.snapshotEvents().filter(event => event.type === 'subagent/descriptor').length, 1)
    assert.equal(Object.hasOwn(call.options, 'parentAgent'), false, 'source UI lifetime does not own this Agent')
    const scoped = await h.service.inspectSession({ sessionId: call.session.id })
    assert.equal(scoped.selected.run.attempts[0].sessionId, call.session.id)
    await assert.rejects(h.service.startSessionRun({ ...runArgs(doc), sessionId: call.session.id }), errorCode('blueprint/nested-run-unavailable'))
    call.finish()
  } })
  h.factoryControls.beforeCreate = async options => {
    const record = (await records(h))[0]
    assert.equal(record.attempts[0].sessionId, options.sessionId)
    assert.equal(record.attempts[0].result, undefined)
    assert.equal(record.source.sessionId, options.meta.parentSession)
  }
  const doc = await h.save(definition()), args = { ...runArgs(doc, {}, 'native-idempotent'), sessionId: h.parent.id }
  const first = await h.service.startSessionRun(args)
  const replay = await h.service.startSessionRun(args)
  assert.equal(first.runId, replay.runId); assert.equal(replay.replayed, true)
  await drain(h)
  assert.deepEqual(h.runtimeFaults, [])
  assert.deepEqual(h.factoryErrors, [])
  assert.equal(h.host.calls.length, 1)
  assert.equal(h.modelCalls(), 1)
  assert.equal(h.storage.read(h.parent.id).events.filter(event => event.type === 'subagent/catalog').length, 1)
})

test('host native navigation: native page and sidebar catalog survive file reopen with no live Agent or implicit execution', async t => {
  const h = await navigationHarness(t)
  const doc = await h.save(definition())
  const start = await h.service.startSessionRun({ ...runArgs(doc), sessionId: h.parent.id })
  await drain(h)
  const child = h.host.calls[0].session
  const before = await h.service.inspectSession({ sessionId: child.id })
  await h.close()
  const ctx = new Context()
  const controller = await nativeServices(ctx, h.rootDir)
  journal(ctx, h.storage.root)
  const fiber = await ctx.plugin(BlueprintService, { runtimeRoot: h.runtimeRoot })
  t.after(async () => { await fiber.dispose(); await ctx.fiber.dispose() })
  const projection = await controller.projections({ sessionId: h.parent.id }, signal())
  assert.deepEqual(projection.values.subagentCatalog, [{ id: child.id, createdAt: child.header.createdAt, mode: 'one-shot' }])
  const page = await controller.page({ address: h.address(child), throughSeq: h.storage.read(child.id).events.length - 1 }, signal())
  assert.ok(JSON.stringify(page).includes(OUTPUT))
  assert.equal(page.records.filter(record => record.type === 'event' && record.event.type === 'subagent/descriptor').length, 1)
  await assert.rejects(controller.page({ address: { ...h.address(child), parentSessionId: 'wrong-parent' }, throughSeq: 0 }, signal()), errorCode('subagent/unauthorized'))
  await assert.rejects(controller.page({ address: { ...h.address(child), mode: 'continuable' }, throughSeq: 0 }, signal()), errorCode('subagent/unauthorized'))
  await assert.rejects(controller.page({ address: { kind: 'session', sessionId: child.id }, throughSeq: 0 }, signal()), errorCode('session/agent-busy'))
  assert.deepEqual(await ctx.blueprint.inspectSession({ sessionId: child.id }), before)
  assert.equal(before.selected.run.runId, start.runId)
  assert.deepEqual(ctx.agents.list(), [])
  assert.equal(ctx.sessions.get(child.id), undefined, 'cold page is read-only, with no activation')
  assert.equal(h.modelCalls(), 1)
})

for (const boundary of ['child-header', 'parent-catalog', 'child-descriptor']) {
  test(`host native navigation: ${boundary} flush failure never dispatches model and raw fault does not escape`, async t => {
    const h = await navigationHarness(t)
    let failed = false
    h.storage.controls.beforeFlush = session => {
      const descriptor = session.snapshotEvents().some(event => event.type === 'subagent/descriptor')
      if (!failed && (boundary === 'parent-catalog' ? session === h.parent.session
        : session !== h.parent.session && descriptor === (boundary === 'child-descriptor'))) {
        failed = true
        throw new Error('NATIVE_FLUSH_SECRET_SENTINEL /private/native-storage')
      }
    }
    const doc = await h.save(definition())
    const start = await h.service.startSessionRun({ ...runArgs(doc), sessionId: h.parent.id })
    await drain(h)
    assert.equal(failed, true, 'actual native public flush participant failed')
    assert.equal(h.modelCalls(), 0)
    const saved = (await records(h))[0]
    assert.equal(saved.runId, start.runId)
    assert.equal(saved.state, 'failed')
    assert.equal(saved.attempts[0].sessionId, h.host.calls[0].session.id)
    assert.equal(saved.source.sessionId, h.parent.id)
    if (boundary !== 'child-descriptor') assert.equal(h.host.calls[0].session.snapshotEvents().some(event => event.type === 'turn/start'), false)
    const view = await h.service.inspectSession({ sessionId: h.parent.id })
    assert.equal(JSON.stringify(view).includes('NATIVE_FLUSH_SECRET_SENTINEL'), false)
    assert.equal(JSON.stringify(view).includes('/private/native-storage'), false)
    assert.equal(h.host.calls[0].disposed, true)
  })
}

test('host native navigation: cancel before first descriptor retains a discovered child with typed diagnostic and no fabricated turn', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const h = await navigationHarness(t, { beforeModel: async () => { entered.resolve(); await release.promise } })
  const doc = await h.save(definition())
  const start = await h.service.startSessionRun({ ...runArgs(doc), sessionId: h.parent.id })
  await entered.promise
  await h.service.cancelRun({ runId: start.runId })
  const runtime = await h.service.configuredRuntime()
  await boundedSettlement(runtime.jobs.get(start.runId))
  const child = h.host.calls[0].session
  assert.equal(h.modelCalls(), 0)
  assert.equal(child.snapshotEvents().some(event => event.type === 'subagent/descriptor'), false)
  assert.equal(child.snapshotEvents().filter(event => event.type === 'turn/start').length, 1, 'only the real followup started a turn')
  const pageError = await h.page(h.address(child), child).catch(error => error)
  assert.equal(pageError.code, 'subagent/catalog-diagnostic')
  release.resolve()
  await drain(h)
  assert.equal(h.modelCalls(), 0)
  assert.equal((await records(h))[0].state, 'cancelled')
})

test('host native navigation: hanging first-turn descriptor flush yields recovery when quiescence is unknown and never dispatches late model', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const h = await navigationHarness(t)
  h.storage.controls.beforeFlush = async session => {
    if (session !== h.parent.session && session.snapshotEvents().some(event => event.type === 'subagent/descriptor')) {
      const call = h.host.calls[0]
      call.agent.cancel = () => {}
      entered.resolve(); await release.promise
    }
  }
  const doc = await h.save(definition())
  const start = await h.service.startSessionRun({ ...runArgs(doc), sessionId: h.parent.id })
  await entered.promise
  const runtime = await h.service.configuredRuntime(), job = runtime.jobs.get(start.runId)
  await h.service.cancelRun({ runId: start.runId })
  try {
    await boundedSettlement(job)
    assert.equal((await runtime.store.get(start.runId)).state, 'recovery_required')
    assert.equal((await runtime.store.get(start.runId)).attempts[0].result, undefined)
    assert.equal(h.modelCalls(), 0)
  } finally { release.resolve() }
  await drain(h)
  assert.equal(h.modelCalls(), 0)
  assert.equal(h.runtimeFaults.length, 1, 'late descriptor flush hits the aborted signal, before model dispatch')
})

test('host native navigation: hanging public flush and disposal respect the existing 20s deadline plus quiescence budget', async t => {
  const entered = Promise.withResolvers(), releaseFlush = Promise.withResolvers(), releaseDispose = Promise.withResolvers()
  const h = await navigationHarness(t)
  h.storage.controls.beforeFlush = async session => {
    if (session === h.parent.session) { entered.resolve(); await releaseFlush.promise }
  }
  h.factoryControls.beforeDispose = async () => { await releaseDispose.promise }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const executor = new BlueprintAgentExecutor(h.service.ctx, h.ctx.agents)
  const job = executor.execute({ ...directSpec(h), source: { sessionId: h.parent.id, kind: 'ui' }, timeoutMs: 20_000 })
  await entered.promise
  t.mock.timers.tick(20_000)
  // Drain promise reactions so cancellation observes the idle child and starts
  // bounded disposal before advancing the existing quiescence observation.
  for (let turn = 0; turn < 30; turn++) await Promise.resolve()
  t.mock.timers.tick(AGENT_CANCEL_QUIESCENCE_MS)
  try {
    const evidence = await job
    assert.equal(evidence.outcome.kind, 'timeout')
    assert.equal(h.modelCalls(), 0)
    assert.equal(h.host.calls[0].session.snapshotEvents().some(event => event.type === 'turn/start'), false)
  } finally { releaseFlush.resolve(); releaseDispose.resolve(); t.mock.timers.reset() }
  await drain(h)
  assert.equal(h.modelCalls(), 0)
})

test('host native navigation: source exact identity cannot be replaced during creation; source release after dispatch does not cancel plugin work', async t => {
  const h = await navigationHarness(t)
  const replacement = { ...h.parent }
  h.factoryControls.afterCreate = async () => {
    h.leaveParent()
    const leaveReplacement = h.ctx.agents.enter(replacement, undefined)
    await h.ctx.agents.announce(replacement, 'startup')
    t.after(leaveReplacement)
  }
  const doc = await h.save(definition())
  await h.service.startSessionRun({ ...runArgs(doc), sessionId: h.parent.id })
  await drain(h)
  assert.equal(h.modelCalls(), 0)
  assert.equal(h.ctx.agents.get(h.parent.id), replacement, 'a real same-id replacement is live')
  assert.equal((await records(h))[0].state, 'failed')
  assert.equal(h.parent.session.snapshotEvents().some(event => event.type === 'subagent/catalog'), false)
  const active = await navigationHarness(t, { onModel: async call => { await active.disposeParent(); call.finish() } })
  const activeDoc = await active.save(definition())
  await active.service.startSessionRun({ ...runArgs(activeDoc), sessionId: active.parent.id })
  await drain(active)
  assert.equal((await records(active))[0].state, 'succeeded')
  assert.equal(active.modelCalls(), 1)
})

test('host native navigation: unknown model effect retains native identity and original recovery semantics after reopen', async t => {
  const h = await navigationHarness(t, { onModel: call => call.quiesceWithoutEnd() })
  const doc = await h.save(definition())
  await h.service.startSessionRun({ ...runArgs(doc), sessionId: h.parent.id })
  await drain(h)
  const saved = (await records(h))[0], child = h.host.calls[0].session
  assert.equal(saved.state, 'recovery_required')
  assert.equal(saved.attempts[0].result, undefined)
  const before = await h.service.inspectSession({ sessionId: child.id })
  await h.close()
  const ctx = new Context(), controller = await nativeServices(ctx, h.rootDir)
  journal(ctx, h.storage.root)
  const fiber = await ctx.plugin(BlueprintService, { runtimeRoot: h.runtimeRoot })
  t.after(async () => { await fiber.dispose(); await ctx.fiber.dispose() })
  assert.deepEqual(await ctx.blueprint.inspectSession({ sessionId: child.id }), before)
  const page = await controller.page({ address: h.address(child), throughSeq: h.storage.read(child.id).events.length - 1 }, signal())
  assert.equal(page.records.filter(record => record.type === 'event' && record.event.type === 'subagent/descriptor').length, 1)
  assert.equal(h.modelCalls(), 1)
  assert.deepEqual(ctx.agents.list(), [])
})

test('host native navigation: global no-source execution keeps its exact legacy header and has no synthesized catalog or descriptor', async t => {
  const h = await navigationHarness(t)
  const doc = await h.save(definition())
  await h.service.startRun(runArgs(doc))
  await drain(h)
  const saved = (await records(h))[0], child = h.host.calls[0].session
  assert.equal(saved.state, 'succeeded')
  assert.equal(Object.hasOwn(saved, 'source'), false)
  assert.equal(child.header.origin, 'subagent')
  assert.equal(Object.hasOwn(child.header, 'parentSession'), false)
  assert.equal(child.snapshotEvents().some(event => event.type === 'subagent/descriptor'), false)
  assert.equal(h.parent.session.snapshotEvents().some(event => event.type === 'subagent/catalog'), false)
})
