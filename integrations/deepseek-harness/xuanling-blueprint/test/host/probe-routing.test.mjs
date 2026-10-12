// Harness-only oracles. No install/boot/browser/profile/provider is invoked.
// Synthetic process reports below prove routing/freshness, NOT real host gates.
import assert from 'node:assert/strict'
import test from 'node:test'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getCases } from './host.mjs'
import {
  probeReportRouting, probeArtifactPaths, isolatedProbeEnv, waitForTerminal, rawScriptUnavailable, terminalCancelEvidence,
} from '../../../../../test/blueprint/capabilities/probe.mjs'

const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
const runner = join(packageRoot, 'scripts', 'verify.mjs')
const probe = fileURLToPath(new URL('../../../../../test/blueprint/capabilities/probe.mjs', import.meta.url))

function temp(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bp-takeover-report-routing-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

const fixtureAssertions = ['P4h', 'P4i', 'P4f', 'P4j-raw', 'P4j', 'P4k', 'P4l', 'P4w'].map(id => ({ id, passed: true }))

async function hostHarness(t, simulate, { explicit = true } = {}) {
  const root = temp(t)
  const plugin = join(root, 'plugin')
  mkdirSync(join(plugin, 'lib'), { recursive: true })
  writeFileSync(join(plugin, 'lib', 'index.js'), '// synthetic build existence fixture; not a product build')
  const historical = join(root, 'test', 'blueprint', 'reports', 'w0', 'w0.2-probe-report.json')
  mkdirSync(dirname(historical), { recursive: true })
  const prior = JSON.stringify({ passed: true, plan_id: 'historical-must-not-be-used', assertions: fixtureAssertions })
  writeFileSync(historical, prior)
  const reportDir = join(root, 'docs', 'validation', 'blueprint', 'current', 'takeover', 'isolated parent with spaces')
  const planId = 'dsh-blueprint-takeover-test'
  const calls = []
  t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    calls.push({ command, args, options })
    return simulate({ command, args, options })
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const [h1] = await getCases({ packageRoot: plugin, repoRoot: root, ...(explicit ? { reportDir, planId } : {}) })
  return { h1, calls, historical, prior, reportDir, planId, root }
}

function fakeReport({ args }, patch = {}) {
  const dir = args[args.indexOf('--report-dir') + 1]
  const planId = args[args.indexOf('--plan-id') + 1]
  writeFileSync(join(dir, 'w0.2-probe-report.json'), JSON.stringify({ passed: true, plan_id: planId, assertions: fixtureAssertions, ...patch }))
  return { status: 0, stdout: '', stderr: '', signal: null }
}

test('report parameters support space/equals forms and route all probe artifacts with the current standalone report root', t => {
  const root = temp(t)
  const spaced = probeReportRouting(['--report-dir', root, '--plan-id', 'takeover'])
  const equal = probeReportRouting([`--report-dir=${root}`, '--plan-id=takeover'])
  assert.deepEqual(spaced, { reportDir: resolve(root), planId: 'takeover' })
  assert.deepEqual(equal, spaced)
  const paths = probeArtifactPaths(spaced.reportDir)
  for (const p of Object.values(paths)) assert.ok(p.startsWith(root + '/'))
  assert.equal(paths.screenshot, join(root, 'w0.2-sidebar.png'))
  assert.equal(paths.securityDir, join(root, 'tools'))
  assert.equal(probeReportRouting([]).planId, 'dsh-blueprint-plugin-v1')
  assert.ok(probeReportRouting([]).reportDir.endsWith('/docs/validation/blueprint/current/w0'))
})

test('missing/empty probe routing values fail before any install, network or report write', t => {
  const root = temp(t)
  for (const args of [['--report-dir'], ['--report-dir='], ['--plan-id', '--keep'], ['--plan-id= ']]) {
    assert.throws(() => probeReportRouting(args), /requires a non-empty value/)
    const child = childProcess.spawnSync(process.execPath, [probe, ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 5000 })
    assert.equal(child.status, 2, child.stderr)
    assert.ok(!child.stdout.includes('[probe] step'), 'invalid route must not begin full probe')
  }
})

test('probe environment is key/config isolated, not a spread of the real environment', t => {
  const home = temp(t)
  const env = isolatedProbeEnv(home, { PATH: '/operational-path', LANG: 'C', HOME: '/real-home', DSH_HOME: '/real-dsh',
    BP_LIVE_PROVIDER_KEY: 'placeholder', OPENAI_API_KEY: 'placeholder', DEEPSEEK_API_KEY: 'placeholder',
    NODE_OPTIONS: '--import /real-config', HTTPS_PROXY: 'secret-proxy', npm_config_userconfig: '/real-npmrc' })
  assert.equal(env.PATH, '/operational-path')
  assert.equal(env.HOME, home)
  assert.equal(env.DSH_HOME, join(home, 'dsh'))
  assert.equal(env.npm_config_userconfig, join(home, '.npmrc'))
  assert.equal(env.npm_config_globalconfig, join(home, 'global.npmrc'))
  for (const key of ['BP_LIVE_PROVIDER_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'NODE_OPTIONS', 'HTTPS_PROXY']) assert.equal(Object.hasOwn(env, key), false)
})

test('host H1 forwards explicit routing into a fresh directory and reads only that report', async t => {
  const f = await hostHarness(t, fakeReport)
  const result = await f.h1.run()
  assert.equal(result.ok, true, 'synthetic harness outcome only, not live evidence')
  assert.equal(f.calls.length, 1)
  const args = f.calls[0].args
  const actual = args[args.indexOf('--report-dir') + 1]
  assert.ok(actual.startsWith(join(f.reportDir, 'host-probe-')))
  assert.equal(args[args.indexOf('--plan-id') + 1], f.planId)
  assert.match(result.detail, /isolated report:/)
  assert.equal(readFileSync(f.historical, 'utf8'), f.prior)
})

test('default host H1 still isolates the nested probe under takeover, not historical w0', async t => {
  const f = await hostHarness(t, fakeReport, { explicit: false })
  assert.equal((await f.h1.run()).ok, true)
  const args = f.calls[0].args
  assert.ok(args[args.indexOf('--report-dir') + 1].startsWith(join(f.root, 'docs', 'validation', 'blueprint', 'current', 'takeover', 'w2', 'host', 'host-probe-')))
  assert.equal(args[args.indexOf('--plan-id') + 1], 'dsh-blueprint-plugin-v1')
  assert.equal(readFileSync(f.historical, 'utf8'), f.prior)
})

test('no new probe report must fail even when a historical report says passed', async t => {
  const f = await hostHarness(t, () => ({ status: 0, stdout: '', stderr: '', signal: null }))
  await assert.rejects(f.h1.run(), /produced no report/)
  assert.equal(readFileSync(f.historical, 'utf8'), f.prior)
})

test('host H1 rejects failed process, mismatched plan, and contradictory or missing required assertions', async t => {
  for (const variant of ['exit', 'plan', 'contradiction', 'missing']) {
    await t.test(variant, async t => {
      const f = await hostHarness(t, call => {
        if (variant === 'exit') { fakeReport(call); return { status: 1, stderr: 'required failure', signal: null } }
        if (variant === 'plan') return fakeReport(call, { plan_id: 'wrong-plan' })
        if (variant === 'contradiction') return fakeReport(call, { assertions: [...fixtureAssertions, { id: 'required-regression', passed: false }] })
        return fakeReport(call, { assertions: fixtureAssertions.filter(a => a.id !== 'P4j') })
      })
      if (variant === 'missing') assert.equal((await f.h1.run()).ok, false)
      else await assert.rejects(f.h1.run(), /failed|mismatch/)
      assert.equal(readFileSync(f.historical, 'utf8'), f.prior)
    })
  }
})

test('raw diagnostic oracle requires actual endpoint unavailability and no side effect, not arbitrary execution failure', () => {
  assert.equal(rawScriptUnavailable({ status: 200, body: { result: { ok: false, error: { code: 'gateway/invocation-unavailable' } } } }, false), true)
  assert.equal(rawScriptUnavailable({ status: 404 }, false), true)
  assert.equal(rawScriptUnavailable({ status: 200, body: { result: { ok: false, error: { code: 'SCRIPT_FAILED' } } } }, false), false)
  assert.equal(rawScriptUnavailable({ status: 200, body: { result: { ok: true } } }, false), false)
  assert.equal(rawScriptUnavailable({ status: 404 }, true), false)
})

test('bounded inspectRun poll observes queued/running/terminal separately from admission', async () => {
  const states = ['queued', 'running', 'succeeded']
  const calls = []
  const inspected = await waitForTerminal(async (...args) => {
    calls.push(args)
    return { status: 200, body: { result: { ok: true, value: { runId: 'run-test', state: states.shift() } } } }
  }, 'run-test', { timeoutMs: 1000, pollIntervalMs: 0 })
  assert.equal(inspected.body.result.value.state, 'succeeded')
  assert.equal(inspected.observations.length, 3)
  assert.equal(calls.length, 3)
  for (const [method, args, , signal] of calls) {
    assert.equal(method, 'blueprint/inspectRun')
    assert.deepEqual(args, { args: { runId: 'run-test' } })
    assert.ok(signal instanceof AbortSignal)
  }
})

test('bounded terminal poll rejects missing admission, bad inspect, unrelated run, and nonterminal budget exhaustion', async () => {
  await assert.rejects(waitForTerminal(() => { throw new Error('must not inspect') }, undefined), /valid runId/)
  await assert.rejects(waitForTerminal(async () => ({ body: { result: { ok: false } } }), 'run-test'), /inspectRun failed/)
  await assert.rejects(waitForTerminal(async () => ({ body: { result: { ok: true, value: { runId: 'other', state: 'succeeded' } } } }), 'run-test'), /unrelated run/)
  await assert.rejects(waitForTerminal(async () => ({ body: { result: { ok: true, value: { runId: 'run-test', state: 'running' } } } }), 'run-test', { timeoutMs: 10, pollIntervalMs: 0 }), /did not settle/)
})

function terminalCancelFixture(mutate = () => {}, beforePatch = {}) {
  const snapshot = { runId: 'run-terminal', state: 'succeeded', definitionRevision: 'revision-1', seq: 5,
    attempts: [{ nodeId: 'in', state: 'succeeded', attempt: 1 }, { nodeId: 'out', state: 'succeeded', attempt: 1 }],
    logTail: ['admitted', 'intent', 'result', 'intent', 'result', 'state'].map((kind, seq) => ({ seq, kind })) }
  const response = value => ({ status: 200, body: { result: { ok: true, value } } })
  const before = response(snapshot)
  Object.assign(snapshot, beforePatch)
  const calls = []
  const callApi = async (method, args, rpcId) => {
    calls.push({ method, args, rpcId })
    const r = response(method === 'blueprint/cancelRun'
      ? { runId: snapshot.runId, state: snapshot.state } : structuredClone(snapshot))
    mutate(r, method, calls.length, snapshot)
    return r
  }
  return { before, calls, run: () => terminalCancelEvidence(callApi, 'run-terminal', before) }
}

test('P4o repeated successful cancel preserves the complete succeeded snapshot after each RPC', async () => {
  const f = terminalCancelFixture()
  const original = structuredClone(f.before.body.result.value)
  const evidence = await f.run()
  assert.equal(evidence.ok, true, evidence.detail)
  assert.equal(evidence.cancels.length, 2)
  assert.equal(evidence.inspections.length, 2)
  assert.deepEqual(f.calls.map(c => c.method), ['blueprint/cancelRun', 'blueprint/inspectRun', 'blueprint/cancelRun', 'blueprint/inspectRun'])
  assert.equal(new Set(f.calls.map(c => c.rpcId)).size, 4)
  for (const c of f.calls) assert.deepEqual(c.args, { args: { runId: 'run-terminal' } })
  for (const r of evidence.cancels) assert.deepEqual(r.body.result.value, { runId: 'run-terminal', state: 'succeeded' })
  for (const r of evidence.inspections) assert.deepEqual(r.body.result.value, original)
  assert.deepEqual(evidence.baseline, original)
})

test('P4o rejects success-shaped mutation or bad RPC evidence, including first-cancel changes later undone', async t => {
  const mutations = {
    seq: r => { r.body.result.value.seq++ },
    logTail: r => { r.body.result.value.logTail.push({ seq: 6, kind: 'cancel' }) },
    attempts: r => { r.body.result.value.attempts[0].attempt++ },
    revision: r => { r.body.result.value.definitionRevision = 'revision-mutated' },
    state: r => { r.body.result.value.state = 'cancelled' },
    runId: r => { r.body.result.value.runId = 'other-run' },
    'missing field': r => { delete r.body.result.value.logTail },
  }
  for (const [name, change] of Object.entries(mutations)) {
    await t.test(name, async () => {
      // Only the FIRST inspect mutates; the second restores the fixture.
      const f = terminalCancelFixture((r, method, n) => { if (method === 'blueprint/inspectRun' && n === 2) change(r) })
      const evidence = await f.run()
      assert.equal(evidence.ok, false, `${name} must not pass as an idempotent terminal cancel`)
      assert.match(evidence.detail, /inspect after cancel 1 changed/)
      assert.deepEqual(evidence.inspections[1].body.result.value, evidence.baseline)
    })
  }
  for (const [name, change] of Object.entries({
    'second cancel wrong state': r => { r.body.result.value.state = 'cancelled' },
    'second cancel missing runId': r => { delete r.body.result.value.runId },
    'second cancel error': r => { r.body.result = { ok: false, error: { code: 'blueprint/illegal-transition' } } },
    'second cancel HTTP failure': r => { r.status = 500 },
    'inspect error': r => { r.body.result = { ok: false, error: { code: 'blueprint/run-not-found' } } },
  })) {
    await t.test(name, async () => {
      const f = terminalCancelFixture((r, _method, n) => { if (n === (name === 'inspect error' ? 2 : 3)) change(r) })
      assert.equal((await f.run()).ok, false, name)
    })
  }
  await t.test('shared baseline object mutated during RPC', async () => {
    const f = terminalCancelFixture((_r, method, _n, snapshot) => { if (method === 'blueprint/cancelRun') snapshot.seq++ })
    assert.equal((await f.run()).ok, false, 'must freeze pre-cancel values, not compare two aliases')
  })
})

test('P4o requires the complete successful terminal baseline before dispatching any cancel', async () => {
  for (const patch of [{ state: 'running' }, { runId: 'unrelated' }, { seq: undefined }, { logTail: undefined }, { attempts: undefined }, { definitionRevision: '' }]) {
    const f = terminalCancelFixture(undefined, patch)
    const evidence = await f.run()
    assert.equal(evidence.ok, false)
    assert.equal(f.calls.length, 0)
    assert.match(evidence.detail, /complete successful terminal/)
  }
})

test('runner passes resolved explicit/default report-dir/plan-id to suite helpers without changing case classifications', t => {
  const root = temp(t)
  const mirror = join(root, 'integrations', 'deepseek-harness', 'xuanling-blueprint')
  const copy = join(mirror, 'scripts', 'verify.mjs')
  const suite = join(mirror, 'test', 'host', 'host.mjs')
  const behaviorEvidence = join(mirror, 'test', 'acceptance', 'behavior-evidence.mjs')
  mkdirSync(dirname(copy), { recursive: true }); mkdirSync(dirname(suite), { recursive: true })
  writeFileSync(copy, readFileSync(runner, 'utf8'))
  // Assemble the real runner's static receipt dependency, never a stub.
  const behaviorBytes = readFileSync(join(packageRoot, 'test', 'acceptance', 'behavior-evidence.mjs'))
  mkdirSync(dirname(behaviorEvidence), { recursive: true })
  writeFileSync(behaviorEvidence, behaviorBytes)
  assert.deepEqual(readFileSync(behaviorEvidence), behaviorBytes, 'mirror receipt module must preserve the real dependency bytes')
  const diagnosticEvidence = join(mirror, 'test', 'live', 'live-diagnostic-evidence.mjs')
  const diagnosticBytes = readFileSync(join(packageRoot, 'test', 'live', 'live-diagnostic-evidence.mjs'))
  mkdirSync(dirname(diagnosticEvidence), { recursive: true })
  writeFileSync(diagnosticEvidence, diagnosticBytes)
  assert.deepEqual(readFileSync(diagnosticEvidence), diagnosticBytes, 'mirror diagnostic module must preserve the real dependency bytes')
  writeFileSync(suite, `import {writeFileSync} from 'node:fs';
    export function getCases(helpers) {
      writeFileSync(process.env.CAPTURE, JSON.stringify({hasReportDir:Object.hasOwn(helpers,'reportDir'),hasPlanId:Object.hasOwn(helpers,'planId'),reportDir:helpers.reportDir,planId:helpers.planId}));
      return [{id:'control',title:'control pass',expect:'pass',run:()=>true},{id:'red',title:'control expected-red',expect:'red',redCode:'CONTROL',run:()=>{throw Object.assign(new Error('control red'),{code:'CONTROL'})}}];
    }`)
  for (const explicit of [true, false]) {
    const capture = join(root, `capture-${explicit}.json`)
    const reports = join(root, 'reports explicit')
    const args = [copy, '--suite', 'host', ...(explicit ? ['--report-dir', reports, '--plan-id', 'takeover-helper-test'] : [])]
    const child = childProcess.spawnSync(process.execPath, args, { encoding: 'utf8', env: { PATH: process.env.PATH, CAPTURE: capture }, timeout: 10000 })
    assert.equal(child.status, 0, child.stderr + child.stdout)
    const helpers = JSON.parse(readFileSync(capture, 'utf8'))
    const expectedReportDir = explicit ? reports : join(root, 'docs', 'validation', 'blueprint', 'current', 'w4')
    const expectedPlanId = explicit ? 'takeover-helper-test' : 'dsh-blueprint-plugin-v1'
    assert.equal(helpers.hasReportDir, true); assert.equal(helpers.hasPlanId, true)
    assert.equal(helpers.reportDir, expectedReportDir)
    assert.equal(helpers.planId, expectedPlanId)
    const reportPath = join(expectedReportDir, 'w4.host-report.json')
    assert.equal(reportPath, join(helpers.reportDir, 'w4.host-report.json'))
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    assert.equal(report.plan_id, expectedPlanId)
    assert.equal(report.plan_id, helpers.planId)
    assert.deepEqual(report.runs[0].results.map(r => r.status), ['pass', 'expected-red'])
    assert.equal(report.passed, true)
  }
  assert.equal(existsSync(join(root, 'test', 'blueprint', 'reports', 'w0')), false)
})
