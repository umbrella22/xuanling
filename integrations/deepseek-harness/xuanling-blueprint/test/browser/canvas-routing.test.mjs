// Synthetic report/process evidence only. Never launches DSH or a browser.
import assert from 'node:assert/strict'
import test from 'node:test'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { getCases } from './browser.mjs'
import { createHash } from 'node:crypto'
import { requiredCanvasAssertions } from '../../../../../test/blueprint/capabilities/canvas-suite.mjs'
import { fixtureEvidence, performanceDefinition } from '../../../../../test/blueprint/capabilities/canvas-fixtures.mjs'
import { getCases as performanceCases } from '../performance/performance.mjs'
import { PERFORMANCE_BUDGET, BROWSER_ASSERTIONS } from '../../../../../test/blueprint/capabilities/canvas-journey.mjs'

function setup(t, simulate) {
  const root = mkdtempSync(join(tmpdir(), 'bp-canvas-report-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'plugin')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  for (const file of ['index.js', 'client.js', 'typert.host.js']) writeFileSync(join(packageRoot, 'lib', file), '// synthetic existence fixture, NOT a product build')
  const oldReport = join(root, 'test', 'blueprint', 'reports', 'w0', 'w0.2-probe-report.json')
  mkdirSync(dirname(oldReport), { recursive: true })
  const prior = JSON.stringify({ passed: true, plan_id: 'historical-do-not-consume', assertions: BROWSER_ASSERTIONS.map(id => ({ id, passed: true })) })
  writeFileSync(oldReport, prior)
  const calls = []
  t.mock.method(childProcess, 'spawnSync', (command, args, options) => { calls.push({ command, args, options }); return simulate({ command, args, options }) })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  return { root, oldReport, prior, calls, helpers: { packageRoot, repoRoot: root, reportDir: join(root, 'takeover parent with spaces'), planId: 'dsh-blueprint-takeover-test' } }
}

test('browser gate rejects a failed new process even when the untouched old w0 report says passed', async t => {
  const f = setup(t, () => ({ status: 1, signal: null, stdout: '', stderr: 'controlled child failure' }))
  const [browser] = await getCases(f.helpers)
  await assert.rejects(browser.run(), /probe process failed/, 'FAILED_CHILD_MUST_NOT_PASS_FROM_OLD_W0_REPORT')
  assert.equal(readFileSync(f.oldReport, 'utf8'), f.prior)
})

// Every generated report below is explicitly a synthetic launcher fixture.
// It exercises the suite boundary, not installation, RPC, UI or performance.
function fakeReport({ args }, patch = {}) {
  const reportDir = args[args.indexOf('--report-dir') + 1]
  const planId = args[args.indexOf('--plan-id') + 1]
  const packageRoot = args.find(a => a.startsWith('--plugin-dir=')).slice('--plugin-dir='.length)
  const mode = args.find(a => a.startsWith('--canvas-test=')).slice('--canvas-test='.length)
  const screenshot = join(reportDir, 'w0.2-sidebar.png')
  const reportPath = join(reportDir, 'tools', 'w2.security-report.json')
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(screenshot, 'synthetic screenshot-path fixture, NOT a real screenshot')
  const nested = { passed: true, plan_id: planId, fixture: 'synthetic-only' }
  writeFileSync(reportPath, JSON.stringify(nested))
  const report = { passed: true, plan_id: planId, started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
    environment: { canvas_test: mode, platform: 'darwin/arm64', node: process.version, browser_version: 'synthetic-source-fixture', dsh_version_output: '0.2.1-alpha.1' },
    assertions: requiredCanvasAssertions(mode).map(id => ({ id, passed: true })),
    artifacts: { sidebar_screenshot: screenshot, host_tools_contract: { status: 0, reportPath, report: nested },
      plugin_source: Object.fromEntries(['lib/index.js', 'lib/client.js', 'lib/typert.host.js'].map(f => [f, createHash('sha256').update(readFileSync(join(packageRoot, f))).digest('hex')])),
      canvas_journey: { provenance: 'real DSH boot graph (synthetic REPORT fixture only)', binding: { fixture: 'synthetic-only' } } }, ...patch }
  if (mode === 'performance') {
    const samples = Array.from({ length: 20 }, (_, i) => ({ index: i, kind: i % 2 === 0 ? 'pan' : 'zoom', type: i % 2 === 0 ? 'pointermove' : 'wheel', trusted: true, startMs: i * 100, changeObservedAt: i * 100 + 16, latencyMs: 32, before: `translate(${i}px)`, after: `translate(${i + 1}px)` }))
    report.artifacts.canvas_performance = { provenance: 'real DSH closure factory (synthetic REPORT only)', budget: PERFORMANCE_BUDGET, fixture: fixtureEvidence(performanceDefinition()), measured: { loadMs: 1500, paintP95Ms: 32 }, samples, viewports: samples.map(s => ({ before: s.before, after: s.after })), canonicalUnchanged: true }
  }
  writeFileSync(join(reportDir, 'w0.2-probe-report.json'), JSON.stringify(report))
  return { status: 0, signal: null, stdout: '', stderr: '' }
}

test('browser helper uses a new route on every execution, forwards explicit plan/mode and leaves old evidence untouched', async t => {
  const f = setup(t, fakeReport)
  const [browser] = await getCases(f.helpers)
  assert.equal(browser.expect, 'pass')
  for (let i = 0; i < 2; i++) assert.equal((await browser.run()).ok, true)
  const dirs = f.calls.map(({ args }) => args[args.indexOf('--report-dir') + 1])
  assert.notEqual(dirs[0], dirs[1])
  for (let i = 0; i < f.calls.length; i++) {
    const { command, args, options } = f.calls[i]
    assert.equal(command, process.execPath)
    assert.equal(args[args.indexOf('--plan-id') + 1], f.helpers.planId)
    assert.ok(args.includes('--canvas-test=browser'))
    assert.ok(resolve(dirs[i]).startsWith(join(f.helpers.reportDir, 'suites', 'browser-probe-')))
    assert.equal(Object.hasOwn(options.env, 'DEEPSEEK_API_KEY'), false)
    assert.equal(Object.hasOwn(options.env, 'HOME'), false)
    assert.equal(Object.hasOwn(options.env, 'NODE_OPTIONS'), false)
  }
  assert.equal(readFileSync(f.oldReport, 'utf8'), f.prior)
})

test('default browser helper is still takeover-isolated, not the standalone historical probe route', async t => {
  const f = setup(t, fakeReport)
  const [browser] = await getCases({ packageRoot: f.helpers.packageRoot, repoRoot: f.root })
  assert.equal((await browser.run()).ok, true)
  const args = f.calls[0].args
  assert.ok(args[args.indexOf('--report-dir') + 1].startsWith(join(f.root, 'docs', 'validation', 'blueprint', 'current', 'takeover', 'suites', 'browser-probe-')))
  assert.equal(args[args.indexOf('--plan-id') + 1], 'dsh-blueprint-takeover-v1')
  assert.equal(readFileSync(f.oldReport, 'utf8'), f.prior)
})

test('missing fresh report can never consume an old successful report', async t => {
  const f = setup(t, () => ({ status: 0, signal: null, stdout: '', stderr: '' }))
  const [browser] = await getCases(f.helpers)
  await assert.rejects(browser.run(), /no fresh report/)
  assert.equal(readFileSync(f.oldReport, 'utf8'), f.prior)
})

test('browser rejects false/missing/duplicate required assertions, stale identity/time, bad paths, nested report or build fingerprint', async t => {
  const patches = [
    ['report failed', { passed: false }],
    ['wrong plan', { plan_id: 'old-plan' }],
    ['stale timestamp', { started_at: '2020-01-01T00:00:00.000Z' }],
    ['future timestamp', { finished_at: '2099-01-01T00:00:00.000Z' }],
    ['wrong mode', { environment: { canvas_test: 'performance' } }],
    ['vacuous', { assertions: [] }],
    ['failed', { assertions: requiredCanvasAssertions('browser').map(id => ({ id, passed: id !== 'P4j-raw' })) }],
    ['duplicate', { assertions: [...requiredCanvasAssertions('browser'), 'P6g'].map(id => ({ id, passed: true })) }],
    ['missing live Agent', { assertions: requiredCanvasAssertions('browser').filter(id => id !== 'P4h').map(id => ({ id, passed: true })) }],
    ['missing real pointer', { assertions: requiredCanvasAssertions('browser').filter(id => id !== 'P6g').map(id => ({ id, passed: true })) }],
    ['missing controlled selection', { assertions: requiredCanvasAssertions('browser').filter(id => id !== 'B-SELECTION').map(id => ({ id, passed: true })) }],
    ['missing refresh', { assertions: requiredCanvasAssertions('browser').filter(id => id !== 'B-BINDING-REFRESH').map(id => ({ id, passed: true })) }],
    ['unconfined artifact', { artifacts: { sidebar_screenshot: '/old/report.png' } }],
    ['missing build/real journey', { artifacts: {} }],
  ]
  for (const [name, patch] of patches) await t.test(name, async sub => {
    const f = setup(sub, call => fakeReport(call, patch))
    const [browser] = await getCases(f.helpers)
    await assert.rejects(browser.run(), undefined, name)
    assert.equal(readFileSync(f.oldReport, 'utf8'), f.prior)
  })
  for (const name of ['nested plan', 'build hash', 'missing binding']) await t.test(name, async sub => {
    const f = setup(sub, call => {
      const result = fakeReport(call)
      const path = join(call.args[call.args.indexOf('--report-dir') + 1], 'w0.2-probe-report.json')
      const r = JSON.parse(readFileSync(path, 'utf8'))
      if (name === 'nested plan') {
        r.artifacts.host_tools_contract.report.plan_id = 'wrong-plan'
        writeFileSync(r.artifacts.host_tools_contract.reportPath, JSON.stringify(r.artifacts.host_tools_contract.report))
      } else if (name === 'build hash') r.artifacts.plugin_source['lib/client.js'] = 'stale-build'
      else delete r.artifacts.canvas_journey.binding
      writeFileSync(path, JSON.stringify(r)); return result
    })
    const [browser] = await getCases(f.helpers); await assert.rejects(browser.run(), undefined, name)
  })
})

test('signal/error/nonzero process can never be laundered by a fresh passed report', async t => {
  for (const patch of [{ status: 1 }, { signal: 'SIGTERM' }, { error: new Error('controlled spawn error') }]) await t.test(JSON.stringify(patch), async sub => {
    const f = setup(sub, call => ({ ...fakeReport(call), ...patch }))
    const [browser] = await getCases(f.helpers); await assert.rejects(browser.run(), /probe process failed/)
  })
})


test('performance module launches its own fresh mode/report, validates measured evidence and never reuses browser or old reports', async t => {
  const f = setup(t, fakeReport)
  const [browser] = await getCases(f.helpers)
  const [performance] = await performanceCases(f.helpers)
  assert.equal(performance.id, 'PERF1'); assert.equal(performance.expect, 'pass')
  assert.equal((await browser.run()).ok, true); assert.equal((await performance.run()).ok, true)
  const [b, p] = f.calls.map(c => c.args[c.args.indexOf('--report-dir') + 1])
  assert.notEqual(b, p); assert.ok(p.startsWith(join(f.helpers.reportDir, 'suites', 'performance-probe-')))
  assert.ok(f.calls[1].args.includes('--canvas-test=performance'))
  assert.equal(readFileSync(f.oldReport, 'utf8'), f.prior)
})

test('performance module cannot pass from boolean assertions if its actual measurement is absent or pointerup-based', async t => {
  for (const mutate of [r => { delete r.artifacts.canvas_performance }, r => { r.artifacts.canvas_performance.samples[0].type = 'pointerup' }]) await t.test('reject bad measurement', async sub => {
    const f = setup(sub, call => {
      const result = fakeReport(call)
      const path = join(call.args[call.args.indexOf('--report-dir') + 1], 'w0.2-probe-report.json')
      const report = JSON.parse(readFileSync(path, 'utf8')); mutate(report); writeFileSync(path, JSON.stringify(report)); return result
    })
    const [performance] = await performanceCases(f.helpers); await assert.rejects(performance.run())
  })
})
