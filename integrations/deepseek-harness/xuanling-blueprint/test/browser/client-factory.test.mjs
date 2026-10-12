// Executable packaged-closure boundary, not a standalone React demo or a
// mounted DSH/browser claim. Main owns the rebuild and real browser gates.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext, Script } from 'node:vm'
import config from '../../vite.config.ts'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const requirePackage = createRequire(resolve(packageRoot, 'package.json'))
const sharedIds = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client']
// Real installed shared libraries, not fake hooks or a require fallback. Every
// react lookup returns this same instance, as in the DSH shared module table.
const shared = new Map(sharedIds.map(id => [id, requirePackage(id)]))

function assertNoNodeGlobals(context, sandbox) {
  for (const key of ['process', 'global', 'Buffer']) {
    assert.equal(runInContext(`typeof ${key}`, context), 'undefined', `VM_MUST_NOT_PROVIDE_NODE_GLOBAL:${key}`)
    assert.equal(Object.hasOwn(sandbox, key), false, `FACTORY_MUST_NOT_INSTALL_NODE_SHIM:${key}`)
  }
}

test('C-08 only the browser client pack folds third-party NODE_ENV while retaining DSH singleton externals', () => {
  const host = config.pack.find(pack => pack.platform === 'node')
  const client = config.pack.find(pack => pack.platform === 'browser')
  assert.ok(host); assert.ok(client)
  assert.equal(client.define?.['process.env.NODE_ENV'], '"production"', 'CLIENT_PACK_MUST_FOLD_THIRD_PARTY_NODE_ENV')
  assert.equal(host.define?.['process.env.NODE_ENV'], undefined, 'HOST_PACK_ENVIRONMENT_MUST_REMAIN_UNCHANGED')
  assert.deepEqual(client.external, sharedIds, 'REACT_SINGLETON_EXTERNALS_MUST_NOT_BE_REPLACED_OR_POLYFILLED')
})

test('C-08 actual packaged factory imports with real shared React seeds and no process/global/Buffer', t => {
  assert.equal(typeof shared.get('react').createElement, 'function')
  assert.equal(typeof shared.get('react').useSyncExternalStore, 'function')
  assert.equal(typeof shared.get('react-dom').createPortal, 'function')
  assert.equal(typeof shared.get('react-dom/client').createRoot, 'function')
  assert.equal(typeof shared.get('react/jsx-runtime').jsx, 'function')
  assert.equal(typeof shared.get('react/jsx-dev-runtime').jsxDEV, 'function')

  const artifact = resolve(packageRoot, 'lib/client.js')
  const closure = readFileSync(artifact, 'utf8')
  t.diagnostic(JSON.stringify({ artifact, artifactSha256: createHash('sha256').update(closure).digest('hex'),
    realReactVersion: shared.get('react').version, seedIds: sharedIds }))
  const registrations = []
  const sandbox = { console, __ModuleLoader__: { load: descriptor => registrations.push(descriptor) } }
  sandbox.window = sandbox
  sandbox.self = sandbox
  const context = createContext(sandbox)
  assert.equal(runInContext('window === globalThis', context), true, 'browser global object fixture')
  assertNoNodeGlobals(context, sandbox)
  // Execute the unmodified artifact's official registration and then its
  // factory import, just as the boot graph does. No rewritten source or shim.
  new Script(closure, { filename: artifact }).runInContext(context)
  assert.equal(registrations.length, 1)
  const [descriptor] = registrations
  assert.equal(descriptor.id, '@xuanling-rs/xuanling-dsh-blueprint')
  assert.equal(typeof descriptor.factory, 'function')
  const requested = []
  const seedRequire = id => {
    assert.ok(shared.has(id), `CLIENT_EXTERNAL_NOT_IN_DSH_SHARED_TABLE:${id}`)
    requested.push(id)
    return shared.get(id)
  }
  let exports
  assert.doesNotThrow(() => { exports = descriptor.factory(seedRequire) }, 'CLIENT_FACTORY_BROWSER_IMPORT_MUST_NOT_REQUIRE_NODE_GLOBALS')
  assert.equal(typeof exports.apply, 'function', 'official plugin export, not a mocked closure')
  assert.ok(Array.isArray(exports.inject))
  assert.ok(requested.includes('react')); assert.ok(requested.includes('react/jsx-runtime')); assert.ok(requested.includes('react-dom'))
  assertNoNodeGlobals(context, sandbox)
  t.diagnostic(JSON.stringify({ requestedSharedModules: requested, nodeGlobalsAbsentAfterFactory: true }))
})
