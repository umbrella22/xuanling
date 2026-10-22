// Native transport/lifecycle regression, not mounted DSH UI acceptance. Cordis,
// Registry and Gateway are real installed code; their closure factories are
// evaluated unmodified. The carrier and slot seats are deterministic fixtures.
import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createContext, runInContext, Script } from 'node:vm'
import * as sourceClient from '../../src/client/index.ts'
import { resolveBlueprintHost } from '../../src/client/adapters/host/remote.ts'
import { TYPERT } from '../../src/typert.host.ts'
import TYPERT_REMOTE from '../../src/typert.remote.ts'
import { BLUEPRINT_LOCALE, en, zh } from '../../src/client/shared/i18n/locales.ts'
import { BLUEPRINT_PACKAGE, BLUEPRINT_INVOCATIONS } from '../../src/typert-descriptors.ts'
import { BlueprintService } from '../../src/index.ts'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'
import { frozenTeamTaskSpecificationFingerprint } from '../../src/teamstage/public-boundary.ts'
import config from '../../vite.config.ts'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const repositoryRoot = resolve(packageRoot, '../../..')
const dshRequire = createRequire(resolve(repositoryRoot, 'test/blueprint/package.json'))
const packageRequire = createRequire(resolve(packageRoot, 'package.json'))
const browserClient = packageName => dshRequire.resolve(`${packageName}/client`, { conditions: new Set(['browser']) })
const cordis = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/cordis')))
const { Context, Service } = cordis
const { TypertRegistry } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-typert-registry')))
const { TypertGatewayService } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-api-gateway')))
const { TypertRemoteService } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-typert-protocol')))
const seeds = new Map([['@deepseek-ai/cordis', cordis]])
for (const id of ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client']) {
  seeds.set(id, packageRequire(id))
}
seeds.set('zod', packageRequire('zod'))
const artifactEvidence = []
function actualFactory(path, factorySeeds = seeds) {
  const source = readFileSync(path, 'utf8')
  const registrations = []
  const sandbox = {
    console,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    __ModuleLoader__: { load: registration => registrations.push(registration) }
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  const vm = createContext(sandbox)
  new Script(source, { filename: path }).runInContext(vm)
  assert.equal(registrations.length, 1, 'official closure registration fixture')
  const requested = []
  const value = registrations[0].factory(id => {
    assert.ok(factorySeeds.has(id), `FACTORY_EXTERNAL_NOT_IN_REAL_SHARED_SEEDS:${id}`)
    requested.push(id)
    return factorySeeds.get(id)
  })
  for (const name of ['process', 'global', 'Buffer']) {
    assert.equal(runInContext(`typeof ${name}`, vm), 'undefined', `NO_NODE_GLOBAL_OR_SHIM:${name}`)
  }
  artifactEvidence.push({ path, sha256: createHash('sha256').update(source).digest('hex'), requested })
  return value
}
const installedRegistry = actualFactory(browserClient('@deepseek-ai/dsh-typert-registry'))
const installedGateway = actualFactory(browserClient('@deepseek-ai/dsh-api-gateway'))
// Execute the installed locale closure unchanged. Only its actual LocaleRuntime
// is exercised: the settings LanguageRow/store are not mounted in this native
// fixture. Their guards throw on ANY use instead of silently faking UI behavior.
const unmountedViewDependency = id =>
  new Proxy(
    {},
    {
      get: (_target, key) => {
        throw new Error(`UNMOUNTED_LOCALE_SETTINGS_DEPENDENCY:${id}:${String(key)}`)
      }
    }
  )
const installedLocale = actualFactory(
  browserClient('@deepseek-ai/dsh-client-locale'),
  new Map([
    ...seeds,
    ['@deepseek-ai/dsh-client-ui-primitives', unmountedViewDependency('ui-primitives')],
    ['@deepseek-ai/dsh-client-store', unmountedViewDependency('store')]
  ])
)
// Main can point the same native/lifecycle oracles at its unified artifact;
// worker evidence uses only an isolated copied package build.
const productionClient = process.env.BLUEPRINT_NATIVE_CLIENT_ARTIFACT ? actualFactory(resolve(process.env.BLUEPRINT_NATIVE_CLIENT_ARTIFACT)) : sourceClient
const document = {
  blueprintId: 'native-fixture',
  definitionJson: '{"schemaVersion":2,"id":"native-fixture"}',
  documentRevision: 'document-1',
  semanticRevision: 'semantic-1',
  layoutRevision: 'layout-1'
}
const teamAction = (state = 'active', code = 'accepted') => ({
  runId: 'native-run',
  team: {
    schemaVersion: 1,
    stageId: 'stage-1',
    runId: 'native-run',
    teamId: 'team-1',
    leadSessionId: 'native-session',
    taskSpecificationFingerprint: 'a'.repeat(64),
    taskId: 'task-1',
    taskRevision: 1,
    state,
    members: [],
    ...(code === 'accepted'
      ? {
          outputAcceptance: {
            code: 'accepted',
            schemaVersion: 1,
            runId: 'native-run',
            stageId: 'stage-1',
            taskId: 'task-1',
            sourceSessionId: 'native-session',
            artifactId: 'artifact-1',
            digest: 'b'.repeat(64),
            evidenceDigest: 'c'.repeat(64),
            checks: ['schema']
          }
        }
      : {}),
    updatedAt: 1
  },
  task: { id: 'task-1', revision: 1, status: state === 'active' ? 'pending' : 'completed' },
  replayed: false
})

async function provideConversationServices(client) {
  const snapshot = { id: 'native-session', removed: false, subagent: null, active: false }
  const listeners = new Set()
  const subscribe = listener => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const binding = { sessionId: 'native-session', session: { getSnapshot: () => snapshot, subscribe } }
  const bindings = new Map([[binding.sessionId, binding]])
  const addresses = new Map()
  const projectionReads = []
  let onRefresh = () => {}
  class SessionsFixture extends Service {
    constructor(ctx) {
      super(ctx, 'sessions')
    }
    binding(sessionId) {
      return bindings.get(sessionId)
    }
    subagentAddress(sessionId) {
      return addresses.get(sessionId)
    }
    async refreshProjections(sessionId) {
      projectionReads.push(sessionId)
      await onRefresh(sessionId)
    }
    get list() {
      return {
        subscribe,
        getSnapshot: () => ({ ids: ['native-session'], byId: { 'native-session': { id: 'native-session' } }, phase: 'ready', projectionsBySession: {} })
      }
    }
  }
  class UiSessionFixture extends Service {
    constructor(ctx) {
      super(ctx, 'uiSession')
    }
  }
  const sessions = client.plugin(SessionsFixture),
    uiSession = client.plugin(UiSessionFixture)
  await sessions
  await uiSession
  return { sessions, uiSession, addresses, projectionReads, bindings, onRefresh: callback => (onRefresh = callback) }
}

async function fixture(t, { gateway = true, localeReady = true, conversationReady = false, setupHost } = {}) {
  const host = new Context()
  const client = new Context()
  t.after(async () => {
    await client.fiber.dispose()
    await host.fiber.dispose()
  })
  await host.plugin(TypertRegistry)
  host.typert.register(TYPERT)
  class RemoteAccessFixture extends Service {
    constructor(ctx) {
      super(ctx, 'remoteAccess')
    }
    decide() {
      return { kind: 'allow' }
    }
    allows() {
      return true
    }
  }
  await host.plugin(RemoteAccessFixture)
  await host.plugin(TypertGatewayService, {})
  const hostCalls = []
  const carrierCalls = []
  const ownerPeer = { signal: new AbortController().signal, principal: { kind: 'owner' }, interactions: 'answer' }
  const rows = new Set()
  const slotEvents = []
  const slotControllers = new Set()
  const locale = new installedLocale.LocaleRuntime(client, undefined, { languages: ['en'], preference: null })
  if (localeReady) client.provide('locale', locale)
  class ConfiguredBlueprint extends TypertRemoteService {
    constructor(ctx) {
      super(ctx, 'blueprint')
    }
    listDefinitions() {
      hostCalls.push(['listDefinitions'])
      return {
        definitions: [
          {
            blueprintId: document.blueprintId,
            name: 'Native configured fixture',
            documentRevision: document.documentRevision,
            semanticRevision: document.semanticRevision
          }
        ]
      }
    }
    loadDefinition(args) {
      hostCalls.push(['loadDefinition', args])
      return { ...document }
    }
    saveDefinition(args) {
      hostCalls.push(['saveDefinition', args])
      return { ...document, definitionJson: args.definitionJson }
    }
    validate(args) {
      hostCalls.push(['validate', args])
      return { ok: true, semanticRevision: document.semanticRevision }
    }
    startRun(args) {
      hostCalls.push(['startRun', args])
      return { runId: 'native-run', semanticRevision: document.semanticRevision, state: 'running', replayed: false }
    }
    startTeamStage(args) {
      hostCalls.push(['startTeamStage', args])
      return teamAction()
    }
    inspectRun(args) {
      hostCalls.push(['inspectRun', args])
      return { runId: args.runId, state: 'succeeded', definitionRevision: document.semanticRevision, seq: 4, attempts: [], logTail: [] }
    }
    cancelRun(args) {
      hostCalls.push(['cancelRun', args])
      return { runId: args.runId, state: 'succeeded' }
    }
    cancelTeamStage(args) {
      hostCalls.push(['cancelTeamStage', args])
      return teamAction('cancelled')
    }
    acceptTeamStageOutput(args) {
      hostCalls.push(['acceptTeamStageOutput', args])
      return teamAction('succeeded')
    }
    decide(args) {
      hostCalls.push(['decide', args])
      return { runId: args.runId, decisionId: args.decisionId, state: 'running', applied: true }
    }
  }
  if (setupHost) await setupHost(host)
  else await host.plugin(ConfiguredBlueprint)
  if (conversationReady) await provideConversationServices(client)
  class SlotsFixture extends Service {
    constructor(ctx) {
      super(ctx, 'slots')
    }
    inject(key, register) {
      const controller = { key }
      const disposeController = this.ctx.effect(() => {
        slotEvents.push({ key, namespaceReady: client.get('remote.blueprint') !== undefined })
        slotControllers.add(controller)
        const disposeRegistration = register()
        assert.equal(typeof disposeRegistration, 'function', 'NATIVE_SLOT_CALLBACK_MUST_RETURN_DISPOSER')
        return () => {
          disposeRegistration()
          slotControllers.delete(controller)
        }
      })
      // Match native SlotRegistry.inject: a synchronous idempotent controller
      // disposer, not void and not an unhandled asynchronous cleanup promise.
      return () => {
        void disposeController()
      }
    }
    register(options, component) {
      const row = { options, component }
      return this.ctx.effect(() => {
        rows.add(row)
        return () => {
          rows.delete(row)
        }
      })
    }
  }
  await client.plugin(installedRegistry)
  await client.plugin(SlotsFixture)
  client.provide('connection', {
    rpc: {
      call: async (path, endpoint, payload, signal) => {
        assert.equal(path, '/api')
        assert.equal(signal instanceof AbortSignal, true)
        carrierCalls.push([path, endpoint, structuredClone(payload)])
        // The carrier decodes into the host realm, as JSON transport does.
        // Use the official RPC dispatcher so success/failure envelopes and
        // strict named-argument decoding are native, not handcrafted here.
        return host.get('typertGateway').dispatchRpc(endpoint, structuredClone(payload), signal, ownerPeer)
      },
      open: () => {
        throw new Error('unexpected stream in direct invocation fixture')
      }
    },
    registerGenerationSource: () => () => {},
    start: () => ({ stop() {} }),
    generation: { getSnapshot: () => undefined },
    isLoopback: true
  })
  if (gateway) await client.plugin(installedGateway)
  t.diagnostic(
    JSON.stringify({
      scope:
        'real native installed factories + Cordis; deterministic carrier/slot seats; real installed LocaleRuntime; guarded unmounted settings deps; no DOM/live acceptance',
      artifacts: artifactEvidence,
      client: process.env.BLUEPRINT_NATIVE_CLIENT_ARTIFACT ?? 'production source',
      node: process.version
    })
  )
  return { host, client, hostCalls, carrierCalls, rows, slotEvents, slotControllers, locale }
}
function ownContribution(ctx, contribution) {
  return ctx.plugin({ inject: ['remote'], apply: scope => scope.get('remote').$mount(contribution) })
}
async function withHost(client, operation) {
  let result
  const fiber = client.plugin({
    inject: ['remote.blueprint'],
    apply: async scope => {
      const link = resolveBlueprintHost(scope)
      assert.ok(link, 'NATIVE_EXACT_NAMESPACE_MUST_RESOLVE')
      result = await operation(link, scope.get('remote.blueprint'))
    }
  })
  try {
    await fiber
    return result
  } finally {
    await fiber.dispose()
  }
}
const ownDescriptors = client => client.typert.remotes.list().filter(d => d.namespace === 'blueprint')

// The optional Team service remains a deterministic external dependency. This
// fixture mounts the actual BlueprintService, its driver and its durable store:
// no prototype surrogate, replaced reducer or fabricated action DTO is used.
async function durableFixture(t, { teamAvailable = true, leadRole = 'lead' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'blueprint-native-durable-'))
  const workspaceRoot = root
  const runtimeRoot = join(root, '.xuanling')
  const lead = { id: 'native-lead', session: { id: 'native-lead', header: { origin: 'root' } } }
  const tasks = new Map()
  const effects = []
  let serviceFiber
  const config = { workspaceRoot, runtimeRoot }
  const records = async () => {
    const opened = await openBlueprintDomain({ path: runtimeRoot })
    try {
      const store = new RunStore(opened.domain)
      return await Promise.all((await store.listRunIds()).map(id => store.get(id)))
    } finally {
      await opened.close()
    }
  }
  const team = {
    membership(agent) {
      assert.equal(agent, lead)
      return { root: lead, id: lead.id, role: leadRole, name: 'lead' }
    },
    listMembers() {
      return [{ id: 'unrelated-member', name: 'unrelated', status: 'running' }]
    },
    spawnTeammate() {
      throw new Error('this fixture never spawns a member')
    },
    sendMessage() {
      throw new Error('this fixture never sends a message')
    },
    async createTask(agent, request) {
      assert.equal(agent, lead)
      effects.push('create')
      const record = (await records()).find(run => run.teamStage?.taskId === undefined && run.teamStage !== undefined)
      assert.ok(record, 'REAL_STORE_HAS_STAGE_BEFORE_NATIVE_EFFECT')
      assert.equal(record.teamStage.teamId, lead.id)
      assert.equal(record.teamStage.leadSessionId, lead.id)
      assert.equal(record.teamStage.effects.at(-1).state, 'pending', 'REAL_STORE_HAS_INTENT_BEFORE_NATIVE_EFFECT')
      const task = { id: `native-task-${tasks.size + 1}`, revision: 1, status: 'pending', subject: request.subject }
      tasks.set(task.id, task)
      return structuredClone(task)
    },
    getTask(agent, id) {
      assert.equal(agent, lead)
      assert.ok(tasks.has(id))
      return structuredClone(tasks.get(id))
    },
    listTasks() {
      return [...tasks.values()].map(task => structuredClone(task))
    },
    updateTask(agent, request) {
      assert.equal(agent, lead)
      assert.equal(request.action, 'delete')
      const task = tasks.get(request.taskId)
      assert.ok(task)
      assert.equal(request.expectedRevision, task.revision)
      task.revision++
      task.status = 'deleted'
      return structuredClone(task)
    },
    waitForChange() {
      throw new Error('this fixture never waits for Team events')
    },
    interrupt() {
      effects.push('interrupt')
      throw new Error('unrelated members must never be interrupted')
    }
  }
  let f
  try {
    f = await fixture(t, {
      setupHost: async host => {
        host.provide('agents', { get: id => (id === lead.id ? lead : undefined) })
        if (teamAvailable) host.provide('agentTeams', team)
        serviceFiber = await host.plugin(BlueprintService, config)
      }
    })
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await ownContribution(f.client, TYPERT_REMOTE)
  const teamDefinition = {
    schemaVersion: 2,
    id: 'native-team-durable',
    name: 'Native Team durable boundary fixture',
    resources: { worker: { kind: 'agent', path: 'lib/agents/worker.md' }, resultSchema: { kind: 'schema', path: 'lib/schemas/result.json' } },
    graph: {
      nodes: [
        {
          id: 'review',
          kind: 'agentTask',
          agentRef: 'worker',
          outputSchemaRef: 'resultSchema',
          outputs: { result: 'json' },
          teamStage: {
            task: { subject: 'Review', description: 'Review the current artifact' },
            members: [{ name: 'worker-one', description: 'Review the artifact.', agentRef: 'worker', context: 'fresh' }],
            requiredChecks: ['schema']
          }
        }
      ],
      edges: []
    }
  }
  const teamDefinitionJson = JSON.stringify(teamDefinition)
  const teamResourceDigests = { worker: 'a'.repeat(64), resultSchema: 'b'.repeat(64) }
  let runtimeStore
  const createTeamRun = async requestId => {
    const store =
      runtimeStore ??
      (await f.host
        .get('blueprint')
        .configuredRuntime()
        .then(runtime => runtime.store))
    runtimeStore = store
    const payloadFingerprint = createHash('sha256').update(`${requestId}\u0000${teamDefinitionJson}`).digest('hex')
    const admission = await store.createRun({ scope: 'run', requestId, payloadFingerprint }, 'team-semantic-1', teamDefinitionJson, '{}', {
      source: { sessionId: lead.id, kind: 'ui' }
    })
    await store.recordIntent(admission.runId, { nodeId: 'review', kind: 'agentTask', resourceDigests: teamResourceDigests })
    return { admission: { ...admission, semanticRevision: 'team-semantic-1', state: 'running' }, args: [] }
  }
  const definition = {
    schemaVersion: 2,
    id: 'native-durable',
    name: 'Native durable boundary fixture',
    resources: {},
    graph: {
      nodes: [
        { id: 'input', kind: 'input' },
        { id: 'review', kind: 'humanDecision' },
        { id: 'output', kind: 'output' }
      ],
      edges: [
        { kind: 'control', from: 'input', to: 'review' },
        { kind: 'control', from: 'review', to: 'output' }
      ]
    }
  }
  const doc = await withHost(f.client, link => link.saveDefinition(definition.id, JSON.stringify(definition), null))
  const start = async requestId => {
    const args = [doc.blueprintId, doc.documentRevision, '{}', requestId]
    const admission = await withHost(f.client, link => link.startRun(...args))
    // Observe the actual driver until its human decision boundary; bounded
    // event turns are an observation budget, never a replacement success oracle.
    for (let turn = 0; turn < 20_000; turn++) {
      const value = await withHost(f.client, link => link.inspectRun(admission.runId))
      if (value.state === 'waiting_input') return { admission, args, value }
      if (['failed', 'cancelled', 'timed_out', 'recovery_required', 'succeeded'].includes(value.state)) {
        assert.fail(`fixture driver missed the human decision boundary: ${value.state}`)
      }
      await nextTurn()
    }
    assert.fail('fixture driver did not reach its human decision boundary')
  }
  const startTeam = async requestId => {
    // Open the actual runtime before inserting the public fixture Run. The
    // service reconciles existing running records on first open; priming it
    // keeps this manually admitted Attempt available for the public boundary
    // instead of letting the background driver claim it first.
    runtimeStore = (await f.host.get('blueprint').configuredRuntime()).store
    return await createTeamRun(requestId)
  }
  return {
    ...f,
    root,
    lead,
    team,
    tasks,
    effects,
    records,
    start,
    startTeam,
    reopen: async () => {
      await serviceFiber.dispose()
      serviceFiber = await f.host.plugin(BlueprintService, config)
    },
    stageArgs: runId => ({
      sessionId: lead.id,
      runId,
      stageId: 'review',
      taskSpecificationFingerprint: frozenTeamTaskSpecificationFingerprint(teamDefinition.graph.nodes[0].teamStage, teamResourceDigests),
      subject: 'Review',
      description: 'Review the current artifact'
    })
  }
}

// This independent control proves the native fixture/import/carrier is legal
// before any failure of production apply is counted as a product red.
test('native control: official mount of unchanged host descriptors routes through installed Gateway and strict host decoder', async t => {
  const f = await fixture(t)
  const assembly = ownContribution(f.client, { package: TYPERT.package, descriptors: TYPERT.invocations })
  await assembly
  const value = await withHost(f.client, link => link.listDefinitions())
  assert.equal(value.definitions[0].blueprintId, document.blueprintId)
  assert.deepEqual(f.carrierCalls, [['/api', 'blueprint/listDefinitions', { args: {} }]])
  await assembly.dispose()
  assert.equal(f.client.get('remote.blueprint'), undefined)
})

test('C-08 production apply mounts native contribution before registering namespace-dependent panel seats', async t => {
  const f = await fixture(t)
  const fiber = f.client.plugin(productionClient)
  await fiber
  assert.ok(f.client.get('remote.blueprint'), 'NATIVE_CONTRIBUTION_MUST_BE_MOUNTED_BY_PRODUCTION_APPLY')
  assert.deepEqual(Array.from(ownDescriptors(f.client), d => d.id).sort(), TYPERT.invocations.map(d => d.id).sort())
  assert.equal(f.rows.size, 2, 'sidebar and main seats must both register')
  assert.equal(f.slotControllers.size, 2, 'both declared-seat lifetimes own actual controller disposers')
  assert.ok(
    f.slotEvents.every(event => event.namespaceReady),
    'PANEL_MUST_REGISTER_ONLY_AFTER_OFFICIAL_MOUNT'
  )
  assert.deepEqual(f.carrierCalls, [], 'bootstrap does not replay or issue commands')
  const main = [...f.rows].find(row => row.options.name === 'main')
  assert.equal(main.options.key, 'xuanling-blueprint')
  assert.equal(main.options.locale, BLUEPRINT_LOCALE, 'MAIN_SLOT_MUST_INJECT_STANDARD_T_SEAT')
  assert.equal(typeof main.component, 'function')
  const methods = ['listDefinitions', 'loadDefinition', 'saveDefinition', 'validate', 'startRun', 'inspectRun', 'cancelRun', 'decide']
  await withHost(f.client, async link => {
    assert.equal((await link.listDefinitions()).definitions[0].blueprintId, document.blueprintId)
    assert.equal((await link.loadDefinition(document.blueprintId)).documentRevision, 'document-1')
    assert.equal((await link.saveDefinition(document.blueprintId, '{}', 'document-1')).blueprintId, document.blueprintId)
    assert.equal((await link.validate('{}')).ok, true)
    assert.equal((await link.startRun(document.blueprintId, 'document-1', '{}', 'request-1')).runId, 'native-run')
    assert.equal((await link.inspectRun('native-run')).seq, 4)
    assert.equal((await link.cancelRun('native-run')).state, 'succeeded')
    assert.equal((await link.decide('native-run', 'decision-1', 'approve')).applied, true)
  })
  assert.deepEqual(
    f.carrierCalls.map(call => call[1]),
    methods.map(method => `blueprint/${method}`)
  )
  assert.deepEqual(
    f.hostCalls.map(call => call[0]),
    methods
  )
})

test('C-08 parent waits for official remote service without depending on its own not-yet-mounted namespace', async t => {
  const f = await fixture(t, { gateway: false })
  const fiber = f.client.plugin(productionClient)
  await fiber
  assert.equal(f.rows.size, 0, 'PANEL_MUST_WAIT_FOR_NATIVE_GATEWAY')
  assert.equal(f.client.get('remote.blueprint'), undefined)
  await f.client.plugin(installedGateway)
  await fiber
  assert.ok(f.client.get('remote.blueprint'), 'NO_PARENT_NAMESPACE_INJECT_DEADLOCK')
  assert.equal(f.rows.size, 2)
  assert.equal((await withHost(f.client, link => link.listDefinitions())).definitions[0].blueprintId, document.blueprintId)
})

test('C-08 native undeclared namespace guard remains enforced; declared panel child can route', async t => {
  const f = await fixture(t)
  await f.client.plugin(productionClient)
  assert.ok(f.client.get('remote.blueprint'), 'NATIVE_CONTRIBUTION_MUST_BE_MOUNTED_BY_PRODUCTION_APPLY')
  let error
  await f.client.plugin({
    inject: ['slots'],
    apply: scope => {
      try {
        void scope.get('remote').blueprint
      } catch (caught) {
        error = caught
      }
    }
  })
  assert.match(error?.message ?? '', /cannot get property "remote\.blueprint" without inject/)
  assert.equal((await withHost(f.client, link => link.listDefinitions())).definitions[0].blueprintId, document.blueprintId)
})

test('C-08 malformed native args are rejected by real strict host Gateway before business mutation', async t => {
  const f = await fixture(t)
  await f.client.plugin(productionClient)
  assert.ok(f.client.get('remote.blueprint'), 'NATIVE_CONTRIBUTION_MUST_BE_MOUNTED_BY_PRODUCTION_APPLY')
  await withHost(f.client, async (_link, namespace) => {
    for (const [method, args] of [
      ['saveDefinition', { blueprintId: document.blueprintId, definitionJson: '{}', expectedRevision: null, rootDir: '/fixture/forbidden' }],
      ['startRun', { blueprintId: document.blueprintId, expectedRevision: 'document-1', inputJson: '{}', requestId: 'x', definitionJson: '{}' }],
      ['loadDefinition', { rootDir: '/fixture/forbidden' }],
      ['decide', { runId: 'native-run', decisionId: 'decision-1', action: 'spoofed' }]
    ]) {
      const result = await namespace[method](args)
      assert.equal(result.ok, false, `STRICT_NATIVE_ARGS_MUST_REJECT:${method}`)
      assert.match(result.error.code, /^gateway\//)
    }
  })
  assert.equal(f.carrierCalls.length, 4, 'malformed request reaches the real strict decoder')
  assert.deepEqual(f.hostCalls, [], 'strict rejection never enters a business method')
})

test('C-08 TeamStage public invocations cross the installed Typert Gateway with strict DTOs', async t => {
  const f = await fixture(t)
  await f.client.plugin(productionClient)
  const startArgs = {
    sessionId: 'native-session',
    runId: 'native-run',
    stageId: 'stage-1',
    taskSpecificationFingerprint: 'a'.repeat(64),
    subject: 'review',
    description: 'Review the artifact'
  }
  const cancelArgs = { sessionId: 'native-session', runId: 'native-run', memberNames: [] }
  const outputArgs = {
    sessionId: 'native-session',
    runId: 'native-run',
    stageId: 'stage-1',
    taskId: 'task-1',
    code: 'accepted',
    schemaVersion: 1,
    artifactId: 'artifact-1',
    digest: 'b'.repeat(64),
    evidenceDigest: 'c'.repeat(64),
    checks: ['schema']
  }
  await withHost(f.client, async link => {
    assert.equal((await link.startTeamStage(startArgs)).team.teamId, 'team-1')
    assert.equal((await link.cancelTeamStage(cancelArgs)).team.state, 'cancelled')
    assert.equal((await link.acceptTeamStageOutput(outputArgs)).team.outputAcceptance.code, 'accepted')
  })
  assert.deepEqual(
    f.carrierCalls.map(call => call[1]),
    ['blueprint/startTeamStage', 'blueprint/cancelTeamStage', 'blueprint/acceptTeamStageOutput']
  )
  assert.deepEqual(
    f.hostCalls.map(call => call[0]),
    ['startTeamStage', 'cancelTeamStage', 'acceptTeamStageOutput']
  )
  assert.deepEqual(f.hostCalls[0][1], startArgs)
  assert.deepEqual(f.hostCalls[1][1], cancelArgs)
  assert.deepEqual(f.hostCalls[2][1], outputArgs)
})

test('C-08 scoped disposal withdraws only blueprint methods and panel seats; remount is ready without duplicates', async t => {
  const f = await fixture(t)
  const otherDescriptor = { ...TYPERT.invocations[0], id: '@native-test/unrelated#other/ping', service: 'other', namespace: 'other' }
  const unrelated = ownContribution(f.client, { package: '@native-test/unrelated', descriptors: [otherDescriptor] })
  await unrelated
  const other = f.client.get('remote.other')[cordis.symbols.original]
  const fiber = f.client.plugin(productionClient)
  await fiber
  assert.ok(f.client.get('remote.blueprint'), 'NATIVE_CONTRIBUTION_MUST_BE_MOUNTED_BY_PRODUCTION_APPLY')
  const staleMethod = f.client.get('remote.blueprint').listDefinitions
  await fiber.dispose()
  assert.equal(f.rows.size, 0, 'scoped panel effects must be withdrawn')
  assert.equal(f.slotControllers.size, 0, 'ctx.effect releases inject controllers as well as seats')
  assert.equal(f.client.get('remote.blueprint'), undefined, 'own namespace withdrawn')
  assert.equal(ownDescriptors(f.client).length, 0, 'own descriptors withdrawn')
  assert.equal(f.client.get('remote.other')[cordis.symbols.original], other, 'unrelated namespace retains identity')
  assert.equal(f.client.typert.remotes.list().filter(d => d.namespace === 'other').length, 1)
  assert.equal((await staleMethod()).ok, false, 'withdrawn method cannot keep dispatching')
  assert.deepEqual(f.carrierCalls, [], 'withdrawn method never enters carrier')
  const remounted = f.client.plugin(productionClient)
  await remounted
  assert.equal(f.rows.size, 2)
  assert.equal(ownDescriptors(f.client).length, TYPERT.invocations.length, 'one descriptor set after remount')
  assert.equal((await withHost(f.client, link => link.listDefinitions())).definitions[0].blueprintId, document.blueprintId)
  await remounted.dispose()
  assert.equal(f.client.get('remote.other')[cordis.symbols.original], other)
})

test('C-08 host and remote select one unchanged strict descriptor/codec source', () => {
  assert.equal(TYPERT.package, BLUEPRINT_PACKAGE)
  assert.equal(TYPERT_REMOTE.package, BLUEPRINT_PACKAGE)
  assert.equal(TYPERT.invocations, BLUEPRINT_INVOCATIONS, 'host cannot fork the descriptor array')
  assert.equal(TYPERT_REMOTE.descriptors, BLUEPRINT_INVOCATIONS, 'client cannot fork the descriptor array')
  assert.deepEqual(Object.keys(TYPERT_REMOTE).sort(), ['descriptors', 'package'], 'client contribution has no host implementation')
  const methods = [
    'inspectBlueprintReference',
    'messageNode',
    'inspectNodeSession',
    'ping',
    'listDefinitions',
    'listResources',
    'loadDefinition',
    'deleteDefinition',
    'createDefinition',
    'saveDefinition',
    'restoreDefinitionRevision',
    'validate',
    'preflightRun',
    'startRun',
    'startSessionRun',
    'startTeamStage',
    'inspectSession',
    'inspectRunView',
    'queryRuns',
    'archiveRun',
    'restoreRun',
    'inspectRun',
    'cancelRun',
    'resolveRecovery',
    'cancelTeamStage',
    'acceptTeamStageOutput',
    'decide',
    'exportDefinition',
    'importDefinition',
    'workflowList',
    'workflowGet',
    'workflowValidate',
    'workflowPropose',
    'workflowApply',
    'workflowRevisions',
    'workflowRevert',
    'workflowRun',
    'workflowInspect',
    'workflowReport'
  ]
  assert.deepEqual(
    BLUEPRINT_INVOCATIONS.map(d => d.method),
    methods
  )
  for (const d of BLUEPRINT_INVOCATIONS) {
    assert.equal(d.id, `${BLUEPRINT_PACKAGE}#blueprint/${d.method}`)
    assert.equal(d.service, 'blueprint')
    assert.equal(d.namespace, 'blueprint')
    assert.deepEqual(d.invocation, { kind: 'direct' })
    assert.ok(d.parameters.every(p => p.wire === 'args' && p.source === 'json' && p.codec.mode === 'strict'))
    assert.equal(d.result.mode, 'strict')
  }
  const decideValue = BLUEPRINT_INVOCATIONS.find(d => d.method === 'decide').result.create()
  const value = { runId: 'native-run', decisionId: 'decision-1', state: 'running', applied: true }
  assert.equal(decideValue.safeParse(value).success, true)
  assert.equal(decideValue.safeParse({ ...value, action: 'approve' }).success, false, 'strict DecideValue never gains an action field')
})

test('C-08 published remote export and official boot dependency match the host-face build entry', () => {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.exports['./remote'], './lib/typert.remote.js')
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-api-gateway',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-session',
    '@deepseek-ai/dsh-client-ui-workspace'
  ])
  assert.deepEqual(Array.from(productionClient.inject), ['slots', 'remote', 'locale'], 'parent must not inject its own namespace')
  const hostPack = config.pack.find(pack => pack.platform === 'node')
  assert.equal(hostPack.entry['typert.remote'], 'src/typert.remote.ts')
  assert.ok(manifest.files.includes('lib/**/*.js'), 'remote contribution is npm-packable')
})

test('C-01 native locale dependency waits without mounting transport/seats; late provider activates once', async t => {
  const f = await fixture(t, { localeReady: false })
  const fiber = f.client.plugin(productionClient)
  await fiber
  assert.equal(f.rows.size, 0)
  assert.equal(f.client.get('remote.blueprint'), undefined, 'no partial bootstrap before required locale')
  assert.equal(f.locale.bind(BLUEPRINT_LOCALE)('panel.label'), 'panel.label')
  f.client.provide('locale', f.locale)
  await fiber
  assert.equal(f.rows.size, 2)
  assert.equal(ownDescriptors(f.client).length, TYPERT.invocations.length)
  assert.equal(f.locale.bind(BLUEPRINT_LOCALE)('panel.label'), en['panel.label'])
  assert.deepEqual(f.carrierCalls, [], 'late locale activation is not a business command')
})

test('C-01 installed locale keeps bound t stable, applies zh/en and external fallback without changing native seat/namespace identity', async t => {
  const f = await fixture(t)
  const fiber = f.client.plugin(productionClient)
  await fiber
  const bound = f.locale.bind(BLUEPRINT_LOCALE)
  const seats = [...f.rows]
  const namespace = f.client.get('remote.blueprint')[cordis.symbols.original]
  const sidebar = seats.find(row => row.options.name === 'sidebar.panellist')
  const initialRevision = f.locale.getSnapshot().revision
  const revisions = []
  const off = f.locale.subscribe(() => revisions.push(f.locale.getSnapshot().revision))
  t.after(off)
  assert.equal(sidebar.options.label(), en['panel.label'])
  f.locale.setLocale('zh')
  assert.equal(sidebar.options.label(), zh['panel.label'])
  assert.equal(f.locale.bind(BLUEPRINT_LOCALE), bound, 'framework translator identity is stable')
  const unknown = '自定义.kind / 原样 ref:端口'
  assert.equal(bound('node.importedKind', { kind: unknown }), zh['node.importedKind'].replace('{kind}', unknown))
  const removeFrench = f.locale.addLanguage({ id: 'fr', label: 'Français', fallback: 'en' })
  const removePartial = f.locale.register(BLUEPRINT_LOCALE, 'fr', { 'panel.label': 'Plan XuanLing' })
  f.locale.setLocale('fr')
  assert.equal(sidebar.options.label(), 'Plan XuanLing')
  assert.equal(bound('status.saved'), en['status.saved'], 'missing external-language keys use native fallback')
  removePartial()
  assert.equal(sidebar.options.label(), en['panel.label'])
  f.locale.setLocale('en')
  removeFrench()
  assert.equal(bound('absent.product.key'), 'absent.product.key', 'missing namespace/common keys retain native key fallback')
  assert.ok(revisions.length > 0 && revisions.every((r, index) => r > (revisions[index - 1] ?? initialRevision)))
  assert.deepEqual([...f.rows], seats, 'locale changes must not remount contributions')
  assert.equal(f.client.get('remote.blueprint')[cordis.symbols.original], namespace)
  assert.deepEqual(f.carrierCalls, [], 'locale changes must never replay a command')
  assert.deepEqual(f.hostCalls, [])
})

test('C-01 Cordis effect releases only own dictionaries on dispose; remount registers once and preserves unrelated language packs', async t => {
  const f = await fixture(t)
  const otherDispose = f.locale.register('native.unrelated', 'en', { title: 'Unrelated' })
  t.after(otherDispose)
  const fiber = f.client.plugin(productionClient)
  await fiber
  const bound = f.locale.bind(BLUEPRINT_LOCALE)
  f.locale.setLocale('zh')
  assert.equal(bound('panel.label'), zh['panel.label'])
  const beforeDispose = f.locale.getSnapshot().revision
  await fiber.dispose()
  assert.ok(f.locale.getSnapshot().revision > beforeDispose, 'dictionary cleanup publishes native revision')
  assert.equal(bound('panel.label'), 'panel.label', 'own zh/en dictionaries released by ctx.effect')
  f.locale.setLocale('en')
  assert.equal(bound('status.saved'), 'status.saved')
  assert.equal(f.locale.bind('native.unrelated')('title'), 'Unrelated')
  assert.equal(f.rows.size, 0)
  assert.equal(f.client.get('remote.blueprint'), undefined)
  const remounted = f.client.plugin(productionClient)
  await remounted
  assert.equal(f.locale.bind(BLUEPRINT_LOCALE), bound)
  assert.equal(bound('panel.label'), en['panel.label'])
  assert.equal(f.rows.size, 2)
  assert.equal(ownDescriptors(f.client).length, TYPERT.invocations.length)
  await remounted.dispose()
  assert.equal(bound('panel.label'), 'panel.label')
  assert.equal(f.locale.bind('native.unrelated')('title'), 'Unrelated')
})

test('native slot fixture returns a synchronous disposer and actually releases the callback exactly once', async t => {
  const f = await fixture(t)
  let installed = 0
  let disposed = 0
  const off = f.client.get('slots').inject('native-disposer-control', () => {
    installed += 1
    return () => {
      disposed += 1
    }
  })
  assert.equal(typeof off, 'function', 'SLOT_INJECT_RETURNS_DISPOSER_NOT_VOID')
  assert.equal(installed, 1)
  assert.equal(disposed, 0)
  assert.equal(f.slotControllers.size, 1)
  off()
  off()
  assert.equal(disposed, 1, 'repeated cleanup is idempotent, not an ignored return value')
  assert.equal(f.slotControllers.size, 0)
})

// Readiness/seat oracle only; this does not claim mounted composer or provider acceptance.
test('C-01/C-02 native conversation seat waits for session services without blocking the global workspace', async t => {
  const f = await fixture(t, { conversationReady: true })
  const fiber = f.client.plugin(productionClient)
  await fiber
  const row = [...f.rows].find(item => item.options.name === 'conversation.view')
  assert.ok(row, 'NATIVE_CONVERSATION_VIEW_SEAT_MISSING')
  assert.equal(row.options.id, 'xuanling-blueprint')
  assert.equal(row.options.locale, BLUEPRINT_LOCALE)
  assert.equal(typeof row.options.label, 'function')
  assert.equal(typeof row.component, 'function')
  assert.equal(typeof row.options.inject, 'function')
  const injected = row.options.inject('native-session')
  assert.equal(typeof injected.controller.refresh, 'function')
  assert.equal(injected.controller.getSnapshot().sessionId, 'native-session')
  assert.equal(row.options.inject('native-session').controller, injected.controller, 'same Session binding preserves controller across tab mounts')
  assert.throws(() => row.options.inject('absent-session'), /session-unavailable/)
  assert.deepEqual(f.carrierCalls, [], 'slot registration/injection has no execution or fetch effects')
  await fiber.dispose()
  assert.equal(f.rows.size, 0)
  assert.equal(f.slotControllers.size, 0)
  assert.deepEqual(f.carrierCalls, [], 'unmount/disposal cannot start, cancel, retry or inspect')
})

test('C-01/C-07 late conversation services add only the native seat; loss withdraws it and leaves workspace/namespace usable', async t => {
  const f = await fixture(t)
  const plugin = f.client.plugin(productionClient)
  await plugin
  const panel = [...f.rows].find(row => row.options.name === 'main')
  const namespace = f.client.get('remote.blueprint')[cordis.symbols.original]
  assert.equal(f.rows.size, 2, 'no conversation services do not block workspace startup')
  const services = await provideConversationServices(f.client)
  await plugin
  assert.equal(f.rows.size, 3)
  const row = [...f.rows].find(row => row.options.name === 'conversation.view')
  assert.ok(row)
  assert.equal(
    [...f.rows].find(row => row.options.name === 'main'),
    panel
  )
  assert.equal(f.client.get('remote.blueprint')[cordis.symbols.original], namespace)
  await services.uiSession.dispose()
  assert.equal(f.rows.size, 2, 'optional conversation teardown leaves global seats mounted')
  assert.equal(f.client.get('remote.blueprint')[cordis.symbols.original], namespace)
  assert.equal(f.carrierCalls.length, 0, 'service/seat transitions issue no business RPC')
})

test('execution sync C-02: optional native navigation arrives late, uses catalog addresses and revokes without replacing editor or controller', async t => {
  const f = await fixture(t)
  const plugin = f.client.plugin(productionClient)
  await plugin
  const services = await provideConversationServices(f.client)
  await plugin
  const panel = [...f.rows].find(row => row.options.name === 'main'),
    row = [...f.rows].find(row => row.options.name === 'conversation.view'),
    injected = row.options.inject('native-session'),
    controller = injected.controller,
    opened = []
  assert.equal(typeof injected.openSession, 'function', 'native seat needs a read-only navigation capability even before optional service arrival')
  assert.equal(await injected.openSession('child-before-service'), false)
  const address = Object.freeze({ parentSessionId: 'native-session', childSessionId: 'execution-child', mode: 'one-shot' })
  services.addresses.set(address.childSessionId, address)
  class UiWorkspaceFixture extends Service {
    constructor(ctx) {
      super(ctx, 'uiWorkspace')
    }
    openSession(target) {
      opened.push(target)
    }
  }
  const workspace = f.client.plugin(UiWorkspaceFixture)
  await workspace
  await plugin
  const ready = [...f.rows].find(row => row.options.name === 'conversation.view').options.inject('native-session')
  assert.equal(ready.controller, controller, 'navigation availability must not discard history selection or polling ownership')
  assert.equal(await ready.openSession('execution-child'), true)
  assert.equal(opened[0], address, 'forward the native catalog address, including actual direct parent and mode')
  assert.equal(await ready.openSession('native-session'), true)
  assert.equal(opened[1], 'native-session', 'a known root is a SessionTarget identity, not a fabricated subagent address')
  assert.equal(
    [...f.rows].find(row => row.options.name === 'main'),
    panel,
    'global editor seat remains the same'
  )
  await workspace.dispose()
  assert.equal(await ready.openSession('execution-child'), false, 'captured callback must not keep a withdrawn service alive')
  assert.equal(opened.length, 2)
  assert.equal(
    [...f.rows].find(row => row.options.name === 'main'),
    panel
  )
  assert.equal([...f.rows].find(row => row.options.name === 'conversation.view').options.inject('native-session').controller, controller)
  assert.deepEqual(f.carrierCalls, [], 'navigation lifecycle cannot create, retry, cancel or mutate a Run')
})

test('execution sync C-02: child navigation refreshes only known catalog owner and refuses absent lineage instead of guessing a parent', async t => {
  const f = await fixture(t)
  const plugin = f.client.plugin(productionClient)
  await plugin
  const services = await provideConversationServices(f.client)
  const opened = []
  class UiWorkspaceFixture extends Service {
    constructor(ctx) {
      super(ctx, 'uiWorkspace')
    }
    openSession(target) {
      opened.push(target)
    }
  }
  await f.client.plugin(UiWorkspaceFixture)
  await plugin
  const row = [...f.rows].find(row => row.options.name === 'conversation.view'),
    injected = row.options.inject('native-session'),
    address = Object.freeze({ parentSessionId: 'native-session', childSessionId: 'cold-child', mode: 'one-shot' })
  assert.equal(typeof injected.openSession, 'function', 'production bootstrap must wire native chat navigation')
  services.onRefresh(owner => {
    assert.equal(owner, 'native-session')
    services.addresses.set(address.childSessionId, address)
  })
  assert.equal(await injected.openSession('cold-child'), true)
  assert.deepEqual(services.projectionReads, ['native-session'])
  assert.equal(opened[0], address)
  services.onRefresh(() => {})
  assert.equal(await injected.openSession('not-in-catalog'), false)
  assert.deepEqual(services.projectionReads, ['native-session', 'native-session'])
  assert.equal(opened.length, 1, 'unknown child is never opened as a plain root Session or invented one-shot child')
  services.onRefresh(() => {
    throw new Error('private-projection-error')
  })
  assert.equal(await injected.openSession('unavailable-child'), false, 'directory failure stays typed/unavailable at the UI boundary')
  assert.equal(opened.length, 1)
  assert.deepEqual(f.carrierCalls, [], 'projection lookup uses native read service and never Blueprint execution RPCs')
})

test('W2.6 durable C-02/C-07/C-09: installed Typert calls the real service, commits intent before Team effect and preserves ordinary Runs', async t => {
  const f = await durableFixture(t)
  const bound = await f.startTeam('bound-run')
  const ordinary = await f.start('ordinary-run')
  const ordinaryBefore = (await f.records()).find(run => run.runId === ordinary.admission.runId)
  const args = f.stageArgs(bound.admission.runId)
  const first = await withHost(f.client, link => link.startTeamStage(args))
  assert.equal(first.team.teamId, f.lead.id)
  assert.equal(first.team.taskId, first.task.id)
  assert.equal(first.replayed, false)
  const durableBeforeInspect = await f.records()
  const canonical = durableBeforeInspect.find(run => run.runId === first.runId)
  assert.equal(canonical.teamStage.effects[0].state, 'succeeded')
  assert.equal(canonical.teamStage.effects[0].resultTaskId, first.task.id)
  for (let repeat = 0; repeat < 3; repeat++) {
    const inspected = await withHost(f.client, link => link.inspectRun(first.runId))
    assert.deepEqual(inspected.team, first.team)
    assert.equal(inspected.seq, canonical.seq)
  }
  assert.deepEqual(await f.records(), durableBeforeInspect, 'INSPECT_CANNOT_MUTATE_CANONICAL_FACTS')
  const replay = await withHost(f.client, link => link.startTeamStage(args))
  assert.equal(replay.replayed, true)
  assert.equal(replay.task.id, first.task.id)
  assert.deepEqual(f.effects, ['create'], 'TASK_REPLAY_CANNOT_CREATE_ANOTHER_NATIVE_TASK')
  const ordinaryReplay = await withHost(f.client, link => link.startRun(...ordinary.args))
  assert.equal(ordinaryReplay.runId, ordinary.admission.runId)
  assert.equal(ordinaryReplay.replayed, true)
  assert.equal((await withHost(f.client, link => link.inspectRun(ordinaryReplay.runId))).team, undefined)
  assert.deepEqual(
    (await f.records()).find(run => run.runId === ordinaryReplay.runId),
    ordinaryBefore
  )
})

for (const [label, options, code] of [
  ['missing optional Team service', { teamAvailable: false }, 'blueprint/team-unavailable'],
  ['caller is not a Lead', { leadRole: 'teammate' }, 'blueprint/team-identity-unavailable']
]) {
  test(`W2.6 durable C-01/C-08: ${label} rejects through installed Typert before a stage write`, async t => {
    const f = await durableFixture(t, options)
    const run = await f.startTeam('guarded-run')
    const before = await f.records()
    await assert.rejects(
      withHost(f.client, link => link.startTeamStage(f.stageArgs(run.admission.runId))),
      error => error.code === code
    )
    assert.deepEqual(await f.records(), before)
    assert.deepEqual(f.effects, [])
  })
}

test('W2.6 durable C-08: forged DTO fields and unavailable caller remain side-effect free at the installed Gateway', async t => {
  const f = await durableFixture(t)
  const run = await f.startTeam('strict-run')
  const before = await f.records()
  const args = f.stageArgs(run.admission.runId)
  await assert.rejects(
    withHost(f.client, link => link.startTeamStage({ ...args, teamId: 'forged' })),
    error => error.code === 'gateway/input-invalid'
  )
  await assert.rejects(
    withHost(f.client, link => link.startTeamStage({ ...args, sessionId: 'absent-session' })),
    error => error.code === 'blueprint/session-unavailable'
  )
  assert.deepEqual(await f.records(), before)
  assert.deepEqual(f.effects, [])
})

test('W2.7.1 durable C-04: task completion alone cannot settle the stage without canonical Attempt and host artifact evidence', async t => {
  const f = await durableFixture(t)
  const run = await f.startTeam('accepted-run')
  const started = await withHost(f.client, link => link.startTeamStage(f.stageArgs(run.admission.runId)))
  const output = {
    sessionId: f.lead.id,
    runId: started.runId,
    stageId: 'review',
    taskId: started.task.id,
    code: 'accepted',
    schemaVersion: 1,
    artifactId: 'artifact-1',
    digest: 'b'.repeat(64),
    evidenceDigest: 'c'.repeat(64),
    checks: ['schema']
  }
  await assert.rejects(
    withHost(f.client, link => link.acceptTeamStageOutput(output)),
    error => error.code === 'blueprint/team-output-rejected'
  )
  assert.equal((await withHost(f.client, link => link.inspectRun(started.runId))).team.outputAcceptance, undefined)
  f.tasks.get(started.task.id).status = 'completed'
  f.tasks.get(started.task.id).revision = 3
  assert.equal((await withHost(f.client, link => link.inspectRun(started.runId))).team.state, 'active')
  await assert.rejects(
    withHost(f.client, link => link.acceptTeamStageOutput(output)),
    error => error.code === 'blueprint/team-output-rejected'
  )
  const inspected = await withHost(f.client, link => link.inspectRun(started.runId))
  assert.equal(inspected.team.state, 'active')
  assert.equal(inspected.team.outputAcceptance, undefined)
})

test('W2.6 durable C-05/C-09: stage cancellation never interrupts a foreign member or settles the ordinary parent Run', async t => {
  const f = await durableFixture(t)
  const run = await f.startTeam('cancelled-run')
  const started = await withHost(f.client, link => link.startTeamStage(f.stageArgs(run.admission.runId)))
  const before = await f.records()
  await assert.rejects(
    withHost(f.client, link => link.cancelTeamStage({ sessionId: f.lead.id, runId: started.runId, memberNames: ['unrelated'] })),
    error => error.code === 'blueprint/team-stage-conflict'
  )
  assert.deepEqual(await f.records(), before)
  const cancelled = await withHost(f.client, link => link.cancelTeamStage({ sessionId: f.lead.id, runId: started.runId, memberNames: [] }))
  assert.equal(cancelled.team.state, 'cancelled')
  const after = (await f.records()).find(record => record.runId === started.runId)
  assert.equal(after.state, before[0].state)
  assert.deepEqual(after.attempts, before[0].attempts)
  assert.deepEqual(f.effects, ['create'])
})

test('W2.6 durable C-06: actual BlueprintService disposal/reopen preserves stage facts and replay does not create another native task', async t => {
  const f = await durableFixture(t)
  const run = await f.startTeam('reopened-run')
  const args = f.stageArgs(run.admission.runId)
  const started = await withHost(f.client, link => link.startTeamStage(args))
  const before = await withHost(f.client, link => link.inspectRun(started.runId))
  await f.reopen()
  const recovered = await withHost(f.client, link => link.inspectRun(started.runId))
  assert.equal(recovered.state, 'recovery_required', 'an unsettled original Attempt cannot resume after service reopen')
  assert.equal(recovered.team.state, 'active', 'known native task facts remain intact while the Run enters recovery')
  assert.equal(recovered.seq, before.seq + 1)
  assert.equal(recovered.attempts.length, before.attempts.length)
  assert.equal(recovered.attempts[0].attemptId, before.attempts[0].attemptId)
  assert.equal(recovered.attempts[0].state, 'recovery_required')
  assert.equal(recovered.team.attemptId, before.team.attemptId)
  assert.equal(recovered.team.taskId, started.task.id)
  await assert.rejects(
    withHost(f.client, link => link.startTeamStage(args)),
    error => error.code === 'blueprint/team-stage-conflict',
    'recovery replay cannot redispatch or rebind the task'
  )
  assert.deepEqual(f.effects, ['create'])
})

test('W2.6 durable C-06/C-08: malformed native result retains unknown-effect recovery across service reopen without redispatch', async t => {
  const f = await durableFixture(t)
  const run = await f.startTeam('unknown-effect-run')
  const args = f.stageArgs(run.admission.runId)
  const create = f.team.createTask
  f.team.createTask = async (...request) => ({ ...(await create(...request)), revision: 2, raw: 'PRIVATE_NATIVE_PAYLOAD_SENTINEL' })
  await assert.rejects(
    withHost(f.client, link => link.startTeamStage(args)),
    error => error.code === 'blueprint/team-task-conflict'
  )
  const before = await withHost(f.client, link => link.inspectRun(run.admission.runId))
  assert.equal(before.state, 'running')
  assert.equal(before.attempts[0].state, 'running')
  assert.equal(before.team.state, 'recovery_required')
  const canonical = (await f.records()).find(record => record.runId === run.admission.runId)
  assert.equal(canonical.teamStage.effects[0].state, 'recovery_required')
  assert.equal(canonical.teamStage.taskId, undefined)
  assert.equal(canonical.teamStage.attemptId, canonical.attempts[0].attemptId, 'public TeamStage is bound to the original graph Attempt')
  assert.equal(JSON.stringify(canonical).includes('PRIVATE_NATIVE_PAYLOAD_SENTINEL'), false)
  const nativeTasks = structuredClone([...f.tasks.entries()])
  const nativeMembers = f.team.listMembers()
  await f.reopen()
  const inspected = await withHost(f.client, link => link.inspectRun(run.admission.runId))
  assert.equal(inspected.state, 'recovery_required')
  assert.equal(inspected.team.state, 'recovery_required')
  assert.equal(inspected.seq, before.seq + 1, 'first real service reopen commits one canonical Team recovery barrier')
  assert.equal(inspected.attempts.length, before.attempts.length)
  assert.equal(inspected.attempts[0].attemptId, before.attempts[0].attemptId)
  assert.equal(inspected.attempts[0].state, 'recovery_required', 'Team recovery synchronizes the original graph Attempt')
  const recoveredRecords = await f.records()
  const recovered = recoveredRecords.find(record => record.runId === run.admission.runId)
  assert.equal(recovered.state, 'recovery_required')
  assert.equal(recovered.teamStage.state, 'recovery_required')
  assert.equal(recovered.seq, canonical.seq + 1)
  assert.equal(recovered.attempts.length, canonical.attempts.length)
  assert.equal(recovered.attempts[0].attemptId, canonical.attempts[0].attemptId)
  assert.equal(recovered.attempts[0].state, 'recovery_required')
  assert.equal(recovered.attempts[0].result, undefined, 'unknown native effect does not fabricate an Attempt result')
  assert.deepEqual(recovered.teamStage.effects, canonical.teamStage.effects, 'unknown effect remains unknown with no fabricated result')
  assert.deepEqual(recovered.teamStage.recovery, canonical.teamStage.recovery)
  assert.equal(recovered.teamStage.taskId, undefined)
  assert.equal(recovered.teamStage.attemptId, canonical.attempts[0].attemptId)
  assert.deepEqual(recovered.log.slice(0, -1), canonical.log)
  assert.equal(recovered.log.at(-1).kind, 'recovery')
  assert.equal(recovered.log.at(-1).seq, recovered.seq)
  assert.deepEqual(recovered.log.at(-1).detail, { effectId: canonical.teamStage.effects[0].effectId, stageId: 'review', reason: 'team-effect-unknown' })
  assert.equal(JSON.stringify(recovered).includes('PRIVATE_NATIVE_PAYLOAD_SENTINEL'), false)
  assert.deepEqual(f.effects, ['create'], 'FIRST_REOPEN_CANNOT_REDISPATCH_UNKNOWN_NATIVE_EFFECT')
  assert.equal(f.tasks.size, 1)
  assert.deepEqual([...f.tasks.entries()], nativeTasks)
  assert.deepEqual(f.team.listMembers(), nativeMembers)
  await f.reopen()
  for (let repeat = 0; repeat < 3; repeat++) {
    assert.deepEqual(await withHost(f.client, link => link.inspectRun(run.admission.runId)), inspected, 'second reopen and repeated inspect are read-only')
  }
  assert.deepEqual(await f.records(), recoveredRecords, 'second reopen adds no recovery fact or seq')
  await assert.rejects(
    withHost(f.client, link => link.startTeamStage(args)),
    error => error.code === 'blueprint/team-stage-conflict'
  )
  assert.deepEqual(await f.records(), recoveredRecords, 'refused replay adds no intent or settled result')
  assert.deepEqual(f.effects, ['create'], 'UNKNOWN_NATIVE_EFFECT_CANNOT_BE_REDISPATCHED')
  assert.equal(f.tasks.size, 1, 'external fixture confirms one effect really happened')
  assert.deepEqual([...f.tasks.entries()], nativeTasks)
  assert.deepEqual(f.team.listMembers(), nativeMembers, 'unrelated native member roster is unchanged')
})
