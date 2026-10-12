import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { parseCli, resolvePlaywrightModule } from '../../../../../test/blueprint/capabilities/conversation-ui.mjs'
import { PLAN_ID, REPORT_ROOT, ROOT, errorCategory } from '../../../../../test/blueprint/capabilities/conversation-evidence.mjs'
import { isolatedEnvironment, commandReceipt } from '../../../../../test/blueprint/capabilities/conversation-runtime.mjs'

const args = () => ['--plan-id', PLAN_ID, '--mode', 'readiness', '--install-mode', 'linked', '--report-dir', join(REPORT_ROOT, `unit-never-created-${randomUUID()}`)]
test('Playwright namespace Chromium retains the exported object and receiver without connecting', () => {
  const chromium = { connectOverCDP() { assert.fail('resolver must not connect') } }
  const namespace = { chromium, default: { chromium: { connectOverCDP() { assert.fail('resolver must not connect') } } } }
  assert.equal(resolvePlaywrightModule(namespace), namespace)
  assert.equal(resolvePlaywrightModule(namespace).chromium, chromium)
})
test('Playwright default Chromium works when the namespace has no usable Chromium', () => {
  const exported = { chromium: { connectOverCDP() { assert.fail('resolver must not connect') } } }
  for (const namespace of [{ default: exported }, { chromium: {}, default: exported }]) {
    assert.equal(resolvePlaywrightModule(namespace), exported)
    assert.equal(resolvePlaywrightModule(namespace).chromium, exported.chromium)
  }
})
test('missing or unusable Playwright Chromium fails with a redacted typed category', () => {
  for (const namespace of [undefined, null, {}, { default: {} }, { chromium: {} },
    { chromium: { connectOverCDP: 'not-callable' }, default: { chromium: {} } }]) {
    assert.throws(() => resolvePlaywrightModule(namespace), error => {
      assert.equal(error.code, 'BROWSER_PLAYWRIGHT_CHROMIUM_UNAVAILABLE')
      assert.equal(errorCategory(error), 'BROWSER_PLAYWRIGHT_CHROMIUM_UNAVAILABLE')
      assert.equal(error.message, error.code)
      return true
    })
  }
})
test('actual installed Playwright import resolves without starting a browser', async () => {
  const require = createRequire(join(ROOT, 'test/blueprint/package.json'))
  const namespace = await import(pathToFileURL(require.resolve('playwright')).href)
  const pw = resolvePlaywrightModule(namespace)
  assert.equal(pw, typeof namespace.chromium?.connectOverCDP === 'function' ? namespace : namespace.default)
  assert.equal(typeof pw.chromium.connectOverCDP, 'function')
})
test('help is standalone and describes every implemented flag without launching or reading keys', () => {
  const result = spawnSync(process.execPath, [join(ROOT, 'test/blueprint/capabilities/conversation-ui.mjs'), '--help'], { encoding: 'utf8',
    env: { PATH: process.env.PATH, NODE_OPTIONS: '', DSH_HOME: '/not-a-profile', BP_LIVE_PROVIDER_KEY: 'unit-ambient-unused' } })
  assert.equal(result.status, 0)
  for (const flag of ['--plan-id', '--mode', '--install-mode', '--pnpm-executable', '--report-dir', '--fixture', '--key-file', '--provider-base-url', '--provider-model', '--provider-protocol']) assert.ok(result.stdout.includes(flag))
  assert.ok(!result.stdout.includes('unit-ambient-unused'))
  assert.match(result.stdout, /keyless does NOT prove/)
  assert.match(result.stdout, /linked is NOT tarball-install/)
  assert.deepEqual(parseCli(['--help']), { help: true })
})
test('parser rejects unknown, duplicate, wrong plan, omitted value and mixed help', () => {
  assert.equal(parseCli(args()).mode, 'readiness')
  assert.equal(parseCli(args().map((item, i, all) => i % 2 === 0 ? `${item}=${all[i + 1]}` : null).filter(Boolean)).installMode, 'linked')
  for (const suffix of [['--unknown', 'x'], ['--mode', 'keyless'], ['--report-dir'], ['--help']]) assert.throws(() => parseCli([...args(), ...suffix]), /CLI_/)
  assert.throws(() => parseCli(args().map(item => item === PLAN_ID ? 'other-plan' : item)), /CLI_PLAN/)
  assert.throws(() => parseCli(['--mode', 'readiness']), /CLI_PLAN/)
})
test('parser rejects relative, root, traversal, outside and existing evidence directory', () => {
  for (const path of ['relative', REPORT_ROOT, `${REPORT_ROOT}/new/../escaped`, '/tmp/outside']) {
    const values = args(); values[values.length - 1] = path
    assert.throws(() => parseCli(values), /REPORT_/)
  }
})
test('live configuration requires isolated file locator, real HTTPS route and explicit protocol', () => {
  const values = args().map(value => value === 'readiness' ? 'live' : value)
  const fixture = join(ROOT, 'test/blueprint/capabilities/conversation-browser.mjs')
  const flags = ['--fixture', fixture, '--key-file', '/private/nonexistent-isolated-unit-key.txt', '--provider-base-url', 'https://api.example.com/v1', '--provider-model', 'model', '--provider-protocol', 'openai-completions']
  assert.equal(parseCli([...values, ...flags]).keyFile, '/private/nonexistent-isolated-unit-key.txt') // locator only; no key read
  assert.throws(() => parseCli(values), /CLI_FIXTURE/)
  assert.throws(() => parseCli([...args(), ...flags]), /CLI_LIVE_FLAGS/)
  for (const endpoint of ['http://api.example.com', 'https://localhost', 'https://127.0.0.1', 'https://user:credential@example.com', 'https://api.example.com?token=omitted']) {
    assert.throws(() => parseCli([...values, ...flags.map(value => value === 'https://api.example.com/v1' ? endpoint : value)]), /CLI_PROVIDER_URL/)
  }
})
test('isolated environment excludes ambient keys, proxy, profile and Node preload', () => {
  const env = isolatedEnvironment('/private/unit-home', { PATH: '/bin', HOME: '/real-home', DSH_HOME: '/real-profile',
    BP_LIVE_PROVIDER_KEY: 'unit-ambient', DEEPSEEK_API_KEY: 'unit-ambient', HTTPS_PROXY: 'private', NODE_OPTIONS: '--import evil', npm_config_registry: 'private', COREPACK_HOME: '/real-cache', PNPM_HOME: '/real-pnpm' })
  assert.equal(env.HOME, '/private/unit-home')
  assert.equal(env.DSH_HOME, '/private/unit-home/dsh')
  assert.equal(env.PATH, '/bin')
  assert.equal(env.COREPACK_HOME, '/private/unit-home/cache/node/corepack')
  for (const key of ['BP_LIVE_PROVIDER_KEY', 'DEEPSEEK_API_KEY', 'HTTPS_PROXY', 'NODE_OPTIONS', 'npm_config_registry', 'PNPM_HOME']) assert.equal(env[key], undefined)
})
test('subprocess receipt preserves real exit failure, null exit, signal and OS error', () => {
  for (const result of [{ status: 1 }, { status: null }, { status: 0, signal: 'SIGTERM' }, { status: 0, error: new Error('unit upstream body omitted') }]) {
    const receipt = commandReceipt('dsh', ['--version'], result, 'unit')
    assert.equal(receipt.passed, false)
    assert.equal(receipt.exitCode, result.status)
    assert.ok(!JSON.stringify(receipt).includes('upstream body'))
  }
  assert.equal(commandReceipt('dsh', ['--version'], { status: 0 }, 'unit').passed, true)
})
