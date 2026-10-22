#!/usr/bin/env node
// W1.1/W1.2 shared fixture (plan: docs/plans/dsh-blueprint-ui-decoupling-development-plan.md,
// plan_id dsh-blueprint-ui-decoupling-v1, contract C-01).
//
// One harness drives BOTH bootstrap entries through the same loader semantics:
//   source   integrations/deepseek-harness/xuanling-blueprint/src/client/index.ts
//   artifact integrations/deepseek-harness/xuanling-blueprint/lib/client.js
// The artifact is the exact built closure-factory bundle real DSH hosts
// serve (window.__ModuleLoader__.load banner). The stub ModuleLoader provides
// the five shared runtime ids from the real installed react/react-dom, so a
// missing module, a second React copy, a missing export or a leaked slot
// fails as a typed ArtifactLoaderError, never as a stub-green.
//
// Stub oracle only: a green run here is NOT real host evidence. The real host
// gate stays with the W0.2 external probe classification (onboarding dialog +
// registry/profile tuple mismatch).

import { createHash, webcrypto } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Script, createContext } from 'node:vm'

export const HERE = dirname(fileURLToPath(import.meta.url))
// capabilities/ -> blueprint/ -> test/ -> repo root
export const REPO = resolve(HERE, '..', '..', '..')
export const BLUEPRINT_ROOT = join(REPO, 'integrations', 'deepseek-harness', 'xuanling-blueprint')
export const ARTIFACT_PATH = join(BLUEPRINT_ROOT, 'lib', 'client.js')
export const SOURCE_ENTRY = join(BLUEPRINT_ROOT, 'src', 'client', 'index.ts')
const PACKAGE_MANIFEST = JSON.parse(readFileSync(join(BLUEPRINT_ROOT, 'package.json'), 'utf8'))
export const PACKAGE_ID = PACKAGE_MANIFEST.name
// Seat identity inside the DSH slot tables (src/client/index.ts PANEL_ID).
// Distinct from the ModuleLoader registration id above.
export const SEAT_ID = 'xuanling-blueprint'

// C-01 request set: every id the DSH ModuleLoader must resolve for the client
// bundle. react/jsx-dev-runtime and react-dom/client stay in the table even
// when the production define folds them out of the current bundle.
export const SHARED_RUNTIME_IDS = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client']

// Stable source literals that must survive into the same build's bundle. They
// calibrate "this lib/client.js was built from this src/client generation"
// without a rebuild (vp pack chunk hashes are not byte-deterministic).
export const SOURCE_MARKERS = [
  'xuanling-blueprint: main seat',
  'xuanling-blueprint: sidebar seat',
  'xuanling-blueprint: conversation seat',
  'sidebar.panellist',
  'conversation.view',
  'xuanling-blueprint-canvas-css'
]

export class ArtifactLoaderError extends Error {
  constructor(code, detail) {
    super('ArtifactLoaderError[' + code + ']: ' + detail)
    this.name = 'ArtifactLoaderError'
    this.code = code
    this.detail = detail
  }
}

const typedCheck = (condition, code, detail) => {
  if (!condition) throw new ArtifactLoaderError(code, detail)
}

export function requireFromBlueprint() {
  return createRequire(join(BLUEPRINT_ROOT, 'package.json'))
}

// Real installed shared runtime, exactly one instance per id, as the DSH
// shared module table provides. No fake hooks, no per-id copies.
export function loadSharedRuntimeTable() {
  const requirePackage = requireFromBlueprint()
  const table = new Map()
  for (const id of SHARED_RUNTIME_IDS) table.set(id, requirePackage(id))
  return table
}

// Duplicate-React detector with real host failure semantics: a component that
// hooks through a DIFFERENT React copy cannot render under the served
// react-dom (invalid hook call). Same-copy rendering is the green direction.
export async function assertSharedRuntimeIdentity(table) {
  for (const id of SHARED_RUNTIME_IDS) {
    typedCheck(table.has(id), 'ARTIFACT_MODULE_MISSING', 'shared table is missing ' + JSON.stringify(id))
  }
  const react = table.get('react')
  const reactDom = table.get('react-dom')
  typedCheck(
    typeof react.createElement === 'function' && typeof react.useState === 'function',
    'ARTIFACT_REACT_IDENTITY_MISMATCH',
    'table react is not a usable React instance'
  )
  typedCheck(typeof reactDom === 'object' && reactDom !== null, 'ARTIFACT_REACT_IDENTITY_MISMATCH', 'table react-dom is missing')
  const requirePackage = requireFromBlueprint()
  const serverEntry = requirePackage.resolve('react-dom/server')
  const server = await import(pathToFileURL(serverEntry).href)
  const jsxRuntime = table.get('react/jsx-runtime')
  const element = jsxRuntime.jsx('div', { 'data-identity-probe': 'w1' })
  typedCheck(react.isValidElement(element) === true, 'ARTIFACT_REACT_IDENTITY_MISMATCH', 'jsx-runtime elements are not valid under the served react')
  function Hooked() {
    const [value] = react.useState(1)
    return jsxRuntime.jsx('div', { children: String(value) })
  }
  try {
    const html = server.renderToStaticMarkup(react.createElement(Hooked))
    typedCheck(html === '<div>1</div>', 'ARTIFACT_REACT_IDENTITY_MISMATCH', 'identity probe rendered unexpected markup: ' + html)
  } catch (error) {
    throw new ArtifactLoaderError(
      'ARTIFACT_REACT_IDENTITY_MISMATCH',
      'hooked render failed under the served table (classic second-React signature): ' + error.message
    )
  }
  const devRuntime = table.get('react/jsx-dev-runtime')
  typedCheck(typeof devRuntime.jsxDEV === 'function', 'ARTIFACT_REACT_IDENTITY_MISMATCH', 'react/jsx-dev-runtime is not served')
  typedCheck(typeof table.get('react-dom/client').createRoot === 'function', 'ARTIFACT_REACT_IDENTITY_MISMATCH', 'react-dom/client is not served')
  return { serverEntry, reactVersion: react.version, probe: '<div>1</div>' }
}

// Minimal browser document stub. documentElement.style must exist because the
// bundled @codemirror/view evaluates browser detection at module scope.
export function createDocumentStub(onStyleInstalled) {
  const installed = []
  return {
    documentElement: { style: {} },
    getElementById: id => installed.find(style => style.id === id) ?? null,
    createElement: tag => ({ tagName: tag, id: '', textContent: '' }),
    head: {
      appendChild: node => {
        installed.push(node)
        onStyleInstalled?.(node)
      }
    },
    installedStyles: installed
  }
}

// Load a built closure-factory bundle through the stub ModuleLoader.
// Every require the factory makes must hit the shared table; the five ids the
// host table offers stay fixed, so an omitted runtime fails typed at request
// time (the W0 red row) and a folded-in second runtime drops a required
// request and fails the floor check instead.
export function loadClosureArtifact({
  artifactPath = ARTIFACT_PATH,
  table,
  expectedId = PACKAGE_ID,
  applySourceMarkers = true,
  applySharedRuntimeFloor = true
} = {}) {
  typedCheck(table instanceof Map && table.size > 0, 'ARTIFACT_MODULE_MISSING', 'shared runtime table was not provided')
  typedCheck(typeof artifactPath === 'string', 'ARTIFACT_FILE_MISSING', 'artifact path was not provided')
  if (!existsSync(artifactPath)) throw new ArtifactLoaderError('ARTIFACT_FILE_MISSING', 'closure artifact not found: ' + artifactPath)
  let closure
  try {
    closure = readFileSync(artifactPath, 'utf8')
  } catch (error) {
    throw new ArtifactLoaderError('ARTIFACT_FILE_MISSING', 'closure artifact unreadable: ' + artifactPath + ': ' + error.message)
  }
  const registrations = []
  const document = createDocumentStub()
  // The VM does not install browser platform globals. GraphEditor and Workspace
  // use the host's native structured clone, independently of ModuleLoader.
  const sandbox = {
    console,
    document,
    crypto: webcrypto,
    structuredClone,
    setInterval,
    clearInterval,
    __ModuleLoader__: { load: descriptor => registrations.push(descriptor) }
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  const context = createContext(sandbox)
  try {
    new Script(closure, { filename: artifactPath }).runInContext(context)
  } catch (error) {
    throw new ArtifactLoaderError('ARTIFACT_REGISTRATION_INVALID', 'closure did not evaluate in the browser sandbox: ' + error.message)
  }
  typedCheck(
    registrations.length === 1,
    'ARTIFACT_REGISTRATION_INVALID',
    'expected exactly one __ModuleLoader__.load registration, observed ' + registrations.length
  )
  const [descriptor] = registrations
  typedCheck(
    descriptor && descriptor.id === expectedId,
    'ARTIFACT_REGISTRATION_INVALID',
    'registered id ' + JSON.stringify(descriptor?.id) + ' != ' + JSON.stringify(expectedId)
  )
  typedCheck(typeof descriptor.factory === 'function', 'ARTIFACT_REGISTRATION_INVALID', 'registration carries no factory(require)')
  if (applySourceMarkers) {
    for (const marker of SOURCE_MARKERS) {
      typedCheck(
        closure.includes(marker),
        'ARTIFACT_SOURCE_MARKER_MISSING',
        'bundle lacks source marker ' + JSON.stringify(marker) + '; artifact is stale vs the src/client generation'
      )
    }
  }
  const requested = []
  const seen = new Set()
  const pluginRequire = id => {
    if (!table.has(id)) {
      if (SHARED_RUNTIME_IDS.includes(id))
        throw new ArtifactLoaderError('ARTIFACT_MODULE_MISSING', 'stub loader omitted ' + JSON.stringify(id) + ' which the factory requested')
      throw new ArtifactLoaderError(
        'ARTIFACT_REQUEST_OUTSIDE_SHARED_TABLE',
        'factory requested ' + JSON.stringify(id) + ' outside the DSH shared module table ' + JSON.stringify(SHARED_RUNTIME_IDS)
      )
    }
    requested.push(id)
    seen.add(id)
    return table.get(id)
  }
  let plugin
  try {
    plugin = descriptor.factory(pluginRequire)
  } catch (error) {
    if (error instanceof ArtifactLoaderError) throw error
    throw new ArtifactLoaderError('ARTIFACT_MODULE_MISSING', 'factory import failed: ' + error.message)
  }
  // Floor: the bundle must take react, the automatic JSX runtime and react-dom
  // from the host table. A folded-in second runtime would drop these requests.
  // Self-test closures may disable the floor to reach later red conditions.
  if (!applySharedRuntimeFloor) return finish()
  for (const required of ['react', 'react/jsx-runtime', 'react-dom']) {
    typedCheck(
      seen.has(required),
      'ARTIFACT_SHARED_RUNTIME_NOT_REQUESTED',
      'factory never requested shared ' + JSON.stringify(required) + '; it may carry a second runtime copy'
    )
  }
  typedCheck(
    plugin && typeof plugin.apply === 'function',
    'ARTIFACT_EXPORT_CONTRACT_INVALID',
    'closure exports no apply function (keys: ' + Object.keys(plugin ?? {}).join(', ') + ')'
  )
  typedCheck(Array.isArray(plugin?.inject) && plugin.inject.length > 0, 'ARTIFACT_EXPORT_CONTRACT_INVALID', 'closure exports no inject array')
  return finish()

  function finish() {
    return {
      id: descriptor.id,
      factory: descriptor.factory,
      plugin,
      requested,
      requestSet: [...seen].sort(),
      artifactSha256: createHash('sha256').update(closure).digest('hex'),
      artifactBytes: Buffer.byteLength(closure, 'utf8'),
      artifactPath,
      document
    }
  }
}

// Cordis-shaped stub host. Children apply eagerly (cordis may defer optional
// children; the lifecycle contract measured here is the settled seat set and
// its full teardown). Effects registered on the root context are disposed by
// hostTeardown() because the host fiber owns them; the plugin disposer owns
// only its own children and mounts, mirroring cordis scope semantics.
export function createStubHost() {
  const measures = {
    effects: [],
    components: [],
    dicts: [],
    mounts: [],
    plugins: [],
    injectDisposals: [],
    unregisters: [],
    installedStyles: [],
    events: []
  }
  const slots = {
    seats: new Map(),
    registrations: new Map(),
    seq: 0,
    inject(name, factory) {
      if (typeof name !== 'string' || typeof factory !== 'function') {
        throw new ArtifactLoaderError('ARTIFACT_SEAT_CONTRACT_MISMATCH', 'slots.inject called with invalid seat descriptor ' + String(name))
      }
      const unregister = factory()
      typedCheck(
        typeof unregister === 'function',
        'ARTIFACT_SEAT_CONTRACT_MISMATCH',
        'seat ' + name + ': register factory returned ' + typeof unregister + ', not a disposer'
      )
      slots.seats.set(name, unregister)
      measures.events.push({ at: 'inject', seat: name })
      return () => {
        if (!slots.seats.has(name)) return
        slots.seats.delete(name)
        measures.injectDisposals.push(name)
        unregister()
        measures.events.push({ at: 'inject-dispose', seat: name })
      }
    },
    register(options, component) {
      const ticket = 'reg-' + ++slots.seq
      typedCheck(options && typeof options.name === 'string', 'ARTIFACT_SEAT_CONTRACT_MISMATCH', 'slots.register descriptor has no name')
      typedCheck(
        typeof component === 'function' || (component && typeof component === 'object'),
        'ARTIFACT_SEAT_CONTRACT_MISMATCH',
        'slot ' + options.name + ': component missing'
      )
      slots.registrations.set(ticket, { name: options.name, id: options.id, key: options.key, order: options.order })
      measures.components.push({ name: options.name, component })
      measures.events.push({ at: 'register', seat: options.name, id: options.id, key: options.key, order: options.order })
      return () => {
        if (!slots.registrations.delete(ticket)) return false
        measures.unregisters.push(options.name)
        measures.events.push({ at: 'unregister', seat: options.name })
        return true
      }
    }
  }
  const locale = {
    register: (name, dictionaries) => {
      measures.dicts.push({ name: String(name), zh: typeof dictionaries?.zh === 'object', en: typeof dictionaries?.en === 'object' })
      return () => measures.events.push({ at: 'dict-dispose', name: String(name) })
    },
    bind: () => key => '[t:' + key + ']'
  }
  const remoteService = {
    $mount: async remote => {
      typedCheck(remote && typeof remote === 'object', 'ARTIFACT_SEAT_CONTRACT_MISMATCH', 'remote.$mount received no typert remote')
      measures.mounts.push({ mounted: true, disposed: false })
      return async () => {
        const mount = measures.mounts[measures.mounts.length - 1]
        if (mount && !mount.disposed) {
          mount.disposed = true
          measures.events.push({ at: 'mount-dispose' })
        }
      }
    }
  }
  const sessionListeners = new Set()
  const sessions = {
    binding: () => null,
    subagentAddress: () => undefined,
    list: {
      getSnapshot: () => ({ byId: {} }),
      subscribe: listener => {
        sessionListeners.add(listener)
        return () => sessionListeners.delete(listener)
      }
    }
  }
  const childScope = injections => {
    const scopeEffects = []
    const scope = {
      get: key =>
        key === 'slots'
          ? slots
          : key === 'remote.blueprint'
            ? {}
            : key === 'remote'
              ? remoteService
              : key === 'locale'
                ? locale
                : key === 'sessions'
                  ? sessions
                  : key === 'uiSession'
                    ? {}
                    : undefined,
      effect: (callback, name) => {
        const disposer = callback()
        scopeEffects.push({ name: String(name), disposer })
        measures.events.push({ at: 'scope-effect', name: String(name) })
      },
      locale
    }
    for (const key of injections ?? []) {
      if (!(key in scope)) Object.defineProperty(scope, key, { get: () => scope.get(key) })
    }
    return { scope, scopeEffects }
  }
  const contextEffects = []
  const context = {
    get: key => (key === 'remote' ? remoteService : undefined),
    effect: (callback, name) => {
      const disposer = callback()
      contextEffects.push({ name: String(name), disposer })
      measures.effects.push(String(name))
      measures.events.push({ at: 'effect', name: String(name) })
    },
    locale,
    plugin: definition => {
      const { scope, scopeEffects } = childScope(definition.inject)
      definition.apply(scope)
      const child = { inject: definition.inject ?? [], scopeEffects, disposed: false }
      child.dispose = async () => {
        if (child.disposed) return
        child.disposed = true
        for (const effect of child.scopeEffects) effect.disposer?.()
        for (const entry of measures.plugins) {
          if (entry.child === child) entry.disposed = true
        }
        measures.events.push({ at: 'plugin-dispose', inject: child.inject })
      }
      measures.plugins.push({ child, inject: child.inject, disposed: false })
      return child
    }
  }
  return {
    context,
    slots,
    measures,
    hostTeardown: async () => {
      for (const effect of contextEffects) effect.disposer?.()
      measures.events.push({ at: 'host-teardown', effects: contextEffects.length })
    },
    snapshot: () => ({
      seats: [...slots.seats.keys()],
      registrations: [...slots.registrations.values()],
      plugins: measures.plugins.map(entry => ({ inject: entry.inject, disposed: entry.disposed })),
      mounts: measures.mounts.map(entry => ({ ...entry })),
      effects: [...measures.effects],
      sessionSubscriptions: sessionListeners.size
    })
  }
}

// Apply -> dispose -> host teardown, then prove no seat, child effect, plugin
// or typert mount survived. A remount must restore the same descriptor set.
// Any residue is a typed leak, not a warning.
export async function runSlotLifecycle(plugin, { remount = true } = {}) {
  const attempt = async label => {
    const host = createStubHost()
    let disposer
    try {
      disposer = await plugin.apply(host.context)
    } catch (error) {
      throw new ArtifactLoaderError('ARTIFACT_DISPOSE_INVALID', label + ': apply threw: ' + error.message)
    }
    typedCheck(
      typeof disposer === 'function',
      'ARTIFACT_DISPOSE_INVALID',
      label + ': apply returned ' + typeof disposer + '; the contribution contract requires an async disposer'
    )
    const settled = host.snapshot()
    await disposer()
    await host.hostTeardown()
    const after = host.snapshot()
    const residue = {
      seats: after.seats,
      registrations: after.registrations,
      undisposedPlugins: after.plugins.filter(entry => !entry.disposed).map(entry => entry.inject),
      undisposedMounts: after.mounts.filter(entry => !entry.disposed).length,
      sessionSubscriptions: after.sessionSubscriptions
    }
    const leaked =
      residue.seats.length > 0 ||
      residue.registrations.length > 0 ||
      residue.undisposedPlugins.length > 0 ||
      residue.undisposedMounts > 0 ||
      residue.sessionSubscriptions > 0
    if (leaked) throw new ArtifactLoaderError('ARTIFACT_SLOT_LIFECYCLE_LEAK', label + ': dispose left ' + JSON.stringify(residue))
    const renderedSlots = await renderRegisteredSlots(host.measures.components)
    return {
      label,
      settled,
      after,
      renderedSlots,
      events: host.measures.events,
      injectDisposals: [...host.measures.injectDisposals],
      unregisters: [...host.measures.unregisters]
    }
  }
  const first = await attempt('apply#1')
  const second = remount ? await attempt('apply#2 (remount)') : null
  return { first, second }
}

// The C-01 slot contract every bootstrap entry must satisfy.
export function assertSeatContract(snapshot) {
  const bySeat = new Map(snapshot.registrations.map(entry => [entry.name, entry]))
  const seatNames = [...bySeat.keys()].sort()
  const expected = ['conversation.view', 'main', 'sidebar.panellist']
  typedCheck(
    JSON.stringify(seatNames) === JSON.stringify(expected),
    'ARTIFACT_SEAT_CONTRACT_MISMATCH',
    'registered seats ' + JSON.stringify(seatNames) + ' != ' + JSON.stringify(expected)
  )
  typedCheck(
    bySeat.get('conversation.view').id === SEAT_ID,
    'ARTIFACT_SEAT_CONTRACT_MISMATCH',
    'conversation.view id ' + JSON.stringify(bySeat.get('conversation.view').id) + ' != ' + JSON.stringify(SEAT_ID)
  )
  typedCheck(
    bySeat.get('sidebar.panellist').id === SEAT_ID,
    'ARTIFACT_SEAT_CONTRACT_MISMATCH',
    'sidebar.panellist id ' + JSON.stringify(bySeat.get('sidebar.panellist').id) + ' != ' + JSON.stringify(SEAT_ID)
  )
  typedCheck(bySeat.get('conversation.view').order === 20, 'ARTIFACT_SEAT_CONTRACT_MISMATCH', 'conversation.view order drifted from 20')
  typedCheck(bySeat.get('sidebar.panellist').order === 91, 'ARTIFACT_SEAT_CONTRACT_MISMATCH', 'sidebar.panellist order drifted from 91')
  typedCheck(bySeat.get('main').key === SEAT_ID, 'ARTIFACT_SEAT_CONTRACT_MISMATCH', 'main seat lost its keyed page identity')
  return { seats: seatNames, seatId: SEAT_ID, registrationId: PACKAGE_ID }
}

// Source-side twin of loadClosureArtifact: same contract checks against
// src/client/index.ts. Requires node --experimental-transform-types because
// the client graph uses TypeScript parameter properties.
export async function loadSourceBootstrap() {
  if (!existsSync(SOURCE_ENTRY)) throw new ArtifactLoaderError('ARTIFACT_FILE_MISSING', 'source bootstrap missing: ' + SOURCE_ENTRY)
  let module
  try {
    module = await import(pathToFileURL(SOURCE_ENTRY).href)
  } catch (error) {
    throw new ArtifactLoaderError(
      'ARTIFACT_SOURCE_IMPORT_UNSUPPORTED',
      'source bootstrap could not be imported; run this probe with node --experimental-transform-types --import ./integrations/deepseek-harness/xuanling-blueprint/scripts/test-tsx-register.mjs: ' +
        error.message
    )
  }
  typedCheck(module && typeof module.apply === 'function', 'ARTIFACT_EXPORT_CONTRACT_INVALID', 'source bootstrap exports no apply function')
  typedCheck(Array.isArray(module.inject) && module.inject.length > 0, 'ARTIFACT_EXPORT_CONTRACT_INVALID', 'source bootstrap exports no inject array')
  return { plugin: { apply: module.apply, inject: module.inject }, sourcePath: SOURCE_ENTRY }
}

// Pre-W1 coverage level: "closure loads and exports exist". Recorded so each
// report can show which defective closures the old entry level would miss.
export function legacyExportsOnlyCheck(plugin) {
  return typeof plugin?.apply === 'function' && Array.isArray(plugin?.inject) && plugin.inject.length > 0
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// Render the actual contribution functions, rather than a probe component that
// only proves the fixture's own React identity. SSR exercises production hooks
// without starting browser effects, remote requests or persistent writes.
export async function renderRegisteredSlots(components, table = loadSharedRuntimeTable()) {
  const requirePackage = requireFromBlueprint()
  const server = requirePackage('react-dom/server')
  const react = table.get('react')
  const snapshot = Object.freeze({ sessionId: 'w1-session', value: null, connection: 'loading', selectedAttemptId: null, errorCode: null })
  const props = {
    t: key => key,
    sessionId: 'w1-session',
    controller: { subscribe: () => () => {}, getSnapshot: () => snapshot }
  }
  return components.map(({ name, component }) => {
    try {
      const html = server.renderToStaticMarkup(react.createElement(component, props))
      typedCheck(typeof html === 'string' && html.length > 0, 'ARTIFACT_SLOT_RENDER_INVALID', name + ': production slot rendered no markup')
      return { name, rendered: true, bytes: Buffer.byteLength(html) }
    } catch (error) {
      if (error instanceof ArtifactLoaderError) throw error
      const identityFailure =
        /Invalid hook call|Cannot read properties of null \(reading 'use|incompatible React versions|A React Element from an older version/.test(error.message)
      throw new ArtifactLoaderError(
        identityFailure ? 'ARTIFACT_REACT_IDENTITY_MISMATCH' : 'ARTIFACT_SLOT_RENDER_INVALID',
        name + ': production slot render failed: ' + error.message
      )
    }
  })
}
