/** Sol A exclusive fixture. Script only the public Agent factory/model boundary;
 * real DSH Tools, scope, Session, production executor/driver and JSON store run.
 * No installed-native-structured assumption, tool policy emulation, sleep, or
 * replacement driver. Temp files are isolated and disposed after every test. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { BlueprintService } from '../../src/index.ts'
import { BlueprintAgentExecutor } from '../../src/host/agent-executor.ts'
import { decodeDefinition, validateDefinition } from '../../src/definition/index.ts'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'

export const sha256 = value => createHash('sha256').update(value).digest('hex')
export const COMPLETED = { kind: 'completed' }
export const AGENT_BYTES = 'AGENT_PROMPT_SECRET_SENTINEL'
export const OUTPUT = 'LEGACY_EXPLICIT_OUTPUT'
export const MODEL = { provider: 'contract-provider', model: 'contract-model', reasoningEffort: 'high' }
export const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'number' } },
  required: ['answer'],
  additionalProperties: false
}
export const agentResources = { worker: { kind: 'agent', path: 'lib/agents/worker.md' } }
export const bindingResources = {
  ...agentResources,
  readset: { kind: 'mcp', bindingId: 'reader' },
  writeset: { kind: 'mcp', bindingId: 'writer' }
}
export const agentNode = (extra = {}) => ({ id: 'work', kind: 'agentTask', agentRef: 'worker', ...extra })
export function definition(nodes = [agentNode()], resources = agentResources, edges = []) {
  const value = { schemaVersion: 2, id: 'runtime-contracts', name: 'Runtime contracts', resources, graph: { nodes, edges } }
  validateDefinition(decodeDefinition(JSON.stringify(value)))
  return value
}
export function structuredDefinition() {
  return definition(
    [
      agentNode({ outputSchemaRef: 'answerSchema', outputs: { object: 'json', text: 'string' } }),
      { id: 'sink', kind: 'output', inputs: { object: 'json', text: 'string' } }
    ],
    { ...agentResources, answerSchema: { kind: 'schema', path: 'lib/schemas/answer.json' } },
    [
      { kind: 'data', from: 'work.object', to: 'sink.object' },
      { kind: 'data', from: 'work.text', to: 'sink.text' }
    ]
  )
}

export function contentTool(name, effect = () => {}) {
  return {
    name,
    description: 'Controlled contract fixture',
    parameters: { type: 'object', additionalProperties: true },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      render: () => [{ type: 'text', text: 'controlled tool completed' }]
    },
    async execute(args, exec) {
      await effect(args, exec)
      return { ok: true }
    }
  }
}
export function executeTool(call, name, args = {}, extra = {}) {
  return call.agent.ctx.tools.execute({
    callId: ToolCallId(randomUUID()),
    name,
    arguments: args,
    agent: call.agent,
    signal: new AbortController().signal,
    ...extra
  })
}

/** Directory collaborator for scripted public Agent/runtime fixtures, including cold reopen. */
export function provideFixtureWorkingDirectory(ctx, defaultDirectory) {
  if (ctx.get('workingDirectory') !== undefined) return
  const directories = new WeakMap()
  const get = session => directories.get(session) ?? session.header.cwd ?? defaultDirectory
  ctx.provide('workingDirectory', {
    get,
    async ensure(agent, signal) {
      signal?.throwIfAborted()
      return get(agent.session)
    },
    async set(agent, path, signal) {
      signal?.throwIfAborted()
      const cwd = resolve(get(agent.session), path)
      directories.set(agent.session, cwd)
      return cwd
    }
  })
}

/** Public create(options), setup(scopedCtx, agent) before publication, void
 * followup/inject, explicit cancel, durable turn/end and quiescence. */
function registryFixture(ctx, onTurn) {
  const calls = []
  const errors = []
  const pending = new Set()
  const registry = {
    async create(options) {
      options.signal?.throwIfAborted()
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
      const idle = Promise.withResolvers()
      let finished = false
      const call = {
        options,
        session,
        published: false,
        disposed: false,
        injections: [],
        toolResults: [],
        finish(reason = COMPLETED, text = OUTPUT) {
          if (finished) return
          finished = true
          if (text)
            session.append(
              'assistant/message',
              { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant', content: [{ type: 'text', text }] }) },
              { surfaceOp: 'append' }
            )
          session.append('turn/end', { turn: 1, reason })
          agent.status = 'idle'
          agent.ctx.emit('agent/status', { agent, status: 'idle' })
          idle.resolve()
        },
        quiesceWithoutEnd() {
          finished = true
          agent.status = 'idle'
          idle.resolve()
        }
      }
      const agent = {
        id: session.id,
        session,
        status: 'idle',
        inject(message) {
          call.injections.push(message)
          session.append('agent/inbox/spliced', { target: 'next-step', start: call.injections.length - 1, inserted: [message] })
          agent.ctx.emit('agent/inbox/inserted', { agent, message })
        },
        followup(message) {
          assert.equal(call.published, true, 'fixture: followup occurs after setup publication')
          agent.status = 'running'
          session.append('turn/start', { turn: 1 })
          session.append('user/message', message, { surfaceOp: 'append' })
          const job = Promise.resolve().then(() => onTurn(call))
          pending.add(job)
          job.then(
            () => pending.delete(job),
            error => {
              pending.delete(job)
              errors.push(error)
              call.finish({ kind: 'error', error: { code: 'UNKNOWN', message: 'fixture script failed' } }, '')
            }
          )
        },
        whenIdle() {
          return agent.status === 'idle' ? Promise.resolve() : idle.promise
        },
        cancel() {
          if (agent.status !== 'idle') call.finish({ kind: 'aborted', reason: { kind: 'parent' } }, '')
        }
      }
      const scope = createScope(ctx, agent)
      agent.ctx = scope.ctx
      call.agent = agent
      try {
        const commit = await options.setup?.(scope.ctx, agent)
        options.signal?.throwIfAborted()
        commit?.commit()
      } catch (error) {
        await scope.dispose()
        throw error
      }
      call.published = true
      calls.push(call)
      return {
        agent,
        async dispose() {
          if (call.disposed) return
          agent.cancel({ kind: 'disposed' })
          await agent.whenIdle()
          await scope.dispose()
          call.disposed = true
        }
      }
    }
  }
  return { registry, calls, errors, pending }
}

export async function harness(t, { onTurn = call => call.finish(), config = {}, tools = true, factory = true, mode = 'native', ptcRun } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bp-agent-contracts-'))
  const rootDir = join(root, '.xuanling', 'workflows', 'runtime-contracts')
  const workspaceRoot = root
  const runtimeRoot = join(root, '.xuanling')
  mkdirSync(join(rootDir, 'lib', 'agents'), { recursive: true })
  mkdirSync(join(rootDir, 'lib', 'schemas'), { recursive: true })
  writeFileSync(join(rootDir, 'lib', 'agents', 'worker.md'), AGENT_BYTES)
  writeFileSync(join(rootDir, 'lib', 'schemas', 'answer.json'), JSON.stringify(SCHEMA))
  const ctx = new Context()
  const sections = []
  ctx.provide('systemPrompt', {
    tools() {
      return () => {}
    },
    section(value) {
      sections.push(value)
      return () => {}
    },
    getSectionOrder() {
      return 100
    }
  })
  ctx.provide('agentDefaultModel', { currentSelection: () => structuredClone(MODEL) })
  // alpha.2 PTC and continuable SubagentRuntime both require this collaborator.
  provideFixtureWorkingDirectory(ctx, rootDir)
  if (ptcRun) {
    ctx.provide('ptcRuntime', {
      language: 'typescript',
      isolation: 'test',
      resolve: request => request,
      run: ptcRun
    })
  }
  const nativeTools = tools ? new ToolRuntime(ctx, { mode }) : undefined
  const effects = []
  const removers = []
  for (const name of ['read_allowed', 'write_other', 'host_denied']) {
    if (nativeTools)
      removers.push(
        nativeTools.register(
          contentTool(name, () => {
            effects.push(name)
          })
        )
      )
  }
  const host = registryFixture(ctx, onTurn)
  if (factory) ctx.provide('agents', host.registry)
  const fiber = await ctx.plugin(BlueprintService, {
    workspaceRoot,
    runtimeRoot,
    ...config
  })
  const service = ctx.blueprint
  const drivers = new Set()
  const driverErrors = []
  const originalDrive = service.driveRun
  t.mock.method(service, 'driveRun', function (...args) {
    const job = originalDrive.apply(this, args)
    drivers.add(job)
    job.then(
      () => drivers.delete(job),
      error => {
        drivers.delete(job)
        driverErrors.push(error)
      }
    )
    return job
  })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await fiber.dispose()
    for (const remove of removers) remove()
    await ctx.fiber.dispose()
  }
  t.after(async () => {
    await close()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    rootDir,
    runtimeRoot,
    ctx,
    service,
    nativeTools,
    host,
    effects,
    drivers,
    driverErrors,
    sections,
    close,
    async save(value) {
      return service.saveDefinition({ blueprintId: value.id, definitionJson: JSON.stringify(value), expectedRevision: null })
    },
    executor: () => new BlueprintAgentExecutor(ctx, host.registry)
  }
}
export const directSpec = (h, extra = {}) => ({
  runId: 'policy-source',
  attemptId: randomUUID(),
  nodeId: 'work',
  agentMd: AGENT_BYTES,
  skills: [],
  input: JSON.stringify({ task: 'INPUT_SECRET_SENTINEL' }),
  cwd: h.rootDir,
  ...extra
})
export const runArgs = (doc, input = { task: 'INPUT_SECRET_SENTINEL' }, requestId = randomUUID()) => ({
  blueprintId: doc.blueprintId,
  expectedRevision: doc.documentRevision,
  inputJson: JSON.stringify(input),
  requestId
})
export async function records(h) {
  const opened = await openBlueprintDomain({ path: h.runtimeRoot })
  try {
    const store = new RunStore(opened.domain)
    return await Promise.all((await store.listRunIds()).map(id => store.get(id)))
  } finally {
    await opened.close()
  }
}
export async function drain(h) {
  // Bounded event turns are only an I/O observation budget, never a success oracle.
  for (let turns = 0; turns < 20_000; turns++) {
    await nextTurn()
    if (h.drivers.size === 0 && h.host.pending.size === 0) {
      assert.deepEqual(h.host.errors, [], 'fixture: scripted public host had no unrelated error')
      assert.deepEqual(h.driverErrors, [], 'fixture: production driver had no unrelated rejection')
      return
    }
  }
  assert.fail('fixture: production jobs did not drain (not contract red evidence)')
}
export async function runSaved(h, value = definition(), input, requestId) {
  const doc = await h.save(value)
  const args = runArgs(doc, input, requestId)
  const admitted = await h.service.startRun(args)
  await drain(h)
  const record = (await records(h)).find(run => run.runId === admitted.runId)
  assert.ok(record, 'fixture: admitted Run is durable')
  return { doc, args, admitted, record }
}
