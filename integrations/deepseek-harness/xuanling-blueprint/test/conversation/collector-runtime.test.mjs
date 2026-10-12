// Preparation oracles. Only CLI --version; no Host boot, browser, install or provider.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as runtime from '../../../../../test/blueprint/capabilities/conversation-runtime.mjs'
import * as evidence from '../../../../../test/blueprint/capabilities/conversation-evidence.mjs'
import { parseCli } from '../../../../../test/blueprint/capabilities/conversation-ui.mjs'
import { observerSource } from '../../../../../test/blueprint/capabilities/conversation-observer.mjs'

const { initProfile, loadOverlayPatches } = await import(pathToFileURL(join(evidence.ROOT, 'test/blueprint/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')).href)

test('collector merges the real DSH init comments and empty array into a native-readable overlay', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'collector-empty-overlay-'))
  try {
    initProfile(root, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const path = join(root, 'cordis.patch.yml'), prior = readFileSync(path, 'utf8')
    assert.match(prior, /^# Your patch layer/)
    assert.deepEqual(loadOverlayPatches('dsh', path), [])
    const patches = '- id: llm-pi-ai\n  disabled: true\n- id: xuanling-blueprint\n  config: {blueprints: {}}'
    writeFileSync(path, runtime.collectorOverlaySource(prior, patches))
    assert.deepEqual(loadOverlayPatches('dsh', path), [{ id: 'llm-pi-ai', disabled: true }, { id: 'xuanling-blueprint', config: { blueprints: {} } }])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('collector preserves the exact bytes and native semantics of a nonempty block overlay', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'collector-block-overlay-'))
  try {
    const prior = '# operator entry\r\n- id: retained\r\n  config: {enabled: true} # keep this comment\r\n'
    const source = runtime.collectorOverlaySource(prior, '- id: conversation-observer\n  disabled: false')
    assert.ok(source.startsWith(prior), 'nonempty prior bytes must remain intact')
    const path = join(root, 'cordis.patch.yml'); writeFileSync(path, source)
    assert.deepEqual(loadOverlayPatches('dsh', path), [{ id: 'retained', config: { enabled: true } }, { id: 'conversation-observer', disabled: false }])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('collector rejects invalid or unsafe nonempty overlay forms instead of clearing them', () => {
  for (const prior of ['id: retained\n', '[\n', '- id: retained\n  config: !!js process.env.TEST_ONLY\n']) {
    assert.throws(() => runtime.collectorOverlaySource(prior, '- id: conversation-observer'), { code: 'HOST_PROFILE_OVERLAY_INVALID' })
  }
  for (const prior of ['# flow list\n[{id: retained}]\n', '- id: retained\n...\n']) {
    assert.throws(() => runtime.collectorOverlaySource(prior, '- id: conversation-observer'), { code: 'HOST_PROFILE_OVERLAY_UNSAFE_MERGE' })
  }
})

test('observer preparation places the bare public LLM module in the active profile before boot', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'collector-observer-profile-'))
  try {
    const steps = []
    const profile = await runtime.prepareProfile({ mode: 'readiness', installMode: 'linked' }, null, root, steps)
    const observer = join(profile.profileDir, 'conversation-observer.mjs')
    assert.ok(existsSync(observer), 'observer module must exist inside the active profile directory')
    assert.equal(readFileSync(observer, 'utf8'), observerSource('@deepseek-ai/dsh-llm'))
    assert.ok(readFileSync(join(profile.profileDir, 'cordis.patch.yml'), 'utf8').includes(`name: ${JSON.stringify(observer)}`))
    assert.equal(existsSync(join(root, 'observer.mjs')), false)
    assert.equal(existsSync(profile.observerFile), false, 'preparation cannot publish observer facts')
    assert.deepEqual(steps.map(step => step.id), ['version', 'linked-profile'])
    assert.equal(steps[0].exitCode, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('actual live profile preparation retains native provider idle policy without reading a credential', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'collector-live-policy-'))
  try {
    const steps = []
    const absentKey = join(root, 'not-a-real-credential')
    const profile = await runtime.prepareProfile({ mode: 'live', installMode: 'linked', keyFile: absentKey,
      providerBaseUrl: 'https://open.bigmodel.cn/api/anthropic', providerModel: 'glm-5.3-flash',
      providerProtocol: 'anthropic-messages' }, null, root, steps)
    const patches = loadOverlayPatches('dsh', join(profile.profileDir, 'cordis.patch.yml'))
    const provider = patches.find(entry => entry.id === 'llm-pi-ai').config.providers['blueprint-live']
    assert.equal(Object.hasOwn(provider, 'streamIdleTimeoutMs'), false,
      'the actual prepared profile must not inject a collector-owned provider idle timeout')
    assert.equal(profile.env.BP_CONVERSATION_KEY_FILE, absentKey)
    assert.equal(existsSync(absentKey), false)
    assert.deepEqual(steps.map(step => step.id), ['version', 'linked-profile'])
    assert.equal(steps[0].exitCode, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('pnpm CLI flag validates a physical installed entry and refuses missing, directory, symlink and unrelated files', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'collector-pnpm-path-'))
  try {
    assert.equal(typeof runtime.pnpmExecutableProvenance, 'function')
    const file = join(root, 'unrelated.cjs'); writeFileSync(file, 'process.exit(0)\n')
    const link = join(root, 'link.cjs'); symlinkSync(file, link)
    for (const path of ['relative.cjs', root, join(root, 'missing.cjs'), file, link]) {
      assert.throws(() => runtime.pnpmExecutableProvenance(path), /(?:HOST_PNPM|PATH_)/)
      const args = ['--plan-id', evidence.PLAN_ID, '--mode', 'readiness', '--install-mode', 'cli', '--report-dir', join(evidence.REPORT_ROOT, `never-created-${root.split('/').at(-1)}`), '--pnpm-executable', path]
      assert.throws(() => parseCli(args), /(?:HOST_PNPM|PATH_)/)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('absent PATH pnpm fails typed before any shim or package installation and reports no upstream body', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'collector-pnpm-absent-'))
  try {
    assert.equal(typeof runtime.preparePnpmEnvironment, 'function')
    const cwd = join(root, 'cwd'); mkdirSync(cwd)
    assert.throws(() => runtime.preparePnpmEnvironment({ root, cwd, env: runtime.isolatedEnvironment(join(root, 'home'), { PATH: cwd }), steps: [] }),
      { code: 'HOST_PNPM_UNAVAILABLE', message: 'HOST_PNPM_UNAVAILABLE' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('owned pnpm launcher shell-quotes real command paths and delegates all arguments and the exit code', () => {
  assert.equal(typeof runtime.pnpmShimSource, 'function')
  const source = runtime.pnpmShimSource({ path: "/private/bin/pnpm 'literal' $(never).cjs", runner: 'node' }, "/private/node 'literal'")
  assert.equal(source, "#!/bin/sh\nexec '/private/node '\\''literal'\\''' '/private/bin/pnpm '\\''literal'\\'' $(never).cjs' \"$@\"\n")
  assert.equal(runtime.pnpmShimSource({ path: '/private/pnpm', runner: 'direct' }), '#!/bin/sh\nexec \'/private/pnpm\' "$@"\n')
})
test('a real executable with exit zero but a non-pnpm version still fails availability', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'collector-not-pnpm-'))
  try {
    const cwd = join(root, 'cwd'), steps = []; mkdirSync(cwd)
    const env = runtime.isolatedEnvironment(join(root, 'home'), { PATH: '/bin' })
    assert.throws(() => runtime.preparePnpmEnvironment({ root, cwd, env, steps, pnpmExecutable: realpathSync(process.execPath) }), { code: 'HOST_PNPM_UNAVAILABLE' })
    assert.equal(steps.length, 1); assert.equal(steps[0].exitCode, 0); assert.equal(steps[0].passed, false)
    assert.equal(steps[0].version, undefined); assert.equal(env.PATH, '/bin')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('CLI install evidence needs successful actual pnpm version and stable executable provenance', () => {
  assert.equal(typeof evidence.validatePnpmInstallEvidence, 'function')
  const executable = { path: '/private/real/pnpm.cjs', sha256: '1'.repeat(64), runner: 'node', packageName: 'pnpm', packageVersion: '11.27.1' }
  const receipt = { provenance: { pnpm: structuredClone(executable) }, steps: [{ id: 'pnpm-available', command: '/private/owned/bin/pnpm', args: ['--version'],
    passed: true, exitCode: 0, signal: null, errorCategory: null, version: '11.27.1', source: 'explicit', executable, shimSha256: '2'.repeat(64) }] }
  assert.doesNotThrow(() => evidence.validatePnpmInstallEvidence(receipt))
  for (const mutate of [r => r.steps = [], r => r.steps[0].exitCode = 1, r => r.steps[0].version = 'not-a-version',
    r => r.provenance.pnpm.sha256 = '3'.repeat(64), r => r.steps[0].shimSha256 = '', r => r.steps[0].version = '12.10.1']) {
    const wrong = structuredClone(receipt); mutate(wrong)
    assert.throws(() => evidence.validatePnpmInstallEvidence(wrong), /EVIDENCE_PNPM/)
  }
})
