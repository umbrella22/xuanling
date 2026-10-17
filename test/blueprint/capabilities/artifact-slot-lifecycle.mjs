#!/usr/bin/env node
// W1.2 shared-React identity and slot disposal oracle (plan_id
// dsh-blueprint-ui-decoupling-v1, contract C-01, work package W1.2).
//
// Green direction: the stub ModuleLoader serves all five shared ids from the
// single real installed React; both bootstrap entries (source and committed
// lib/client.js) apply, register the C-01 seats, dispose with zero residual
// seats/registrations/plugins/mounts and remount identically, three consecutive
// times.
//
// Red direction: a table that hands out a SECOND React copy must fail
// ARTIFACT_REACT_IDENTITY_MISMATCH with the real invalid-hook-call signature,
// and closures that leak seats (none disposed / partially disposed) must fail
// ARTIFACT_SLOT_LIFECYCLE_LEAK. The pre-W1 exports-only coverage level is
// recorded against the leaky closure to show the gap this oracle closes.
//
// Stub oracle only: green here is NOT real host evidence; see classification.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ARTIFACT_PATH,
  ArtifactLoaderError,
  REPO,
  SHARED_RUNTIME_IDS,
  assertSeatContract,
  assertSharedRuntimeIdentity,
  legacyExportsOnlyCheck,
  loadClosureArtifact,
  loadSharedRuntimeTable,
  loadSourceBootstrap,
  runSlotLifecycle,
  requireFromBlueprint
} from './artifact-loader-fixture.mjs'

const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(name)
  return index >= 0 ? resolve(args[index + 1]) : undefined
}
const REPORT_DIR = option('--report-dir') ?? join(REPO, 'docs', 'validation', 'blueprint', 'current', 'w1')
const REPORT_PATH = join(REPORT_DIR, 'w1.2-artifact-slot-lifecycle-report.json')
// Plan 6.10: cleanup/lifecycle contracts need three consecutive passes; any
// failure resets the count.
const REQUIRED_CONSECUTIVE_RUNS = 3

const report = {
  probe: 'w1.2-shared-react-and-slot-disposal',
  plan_id: 'dsh-blueprint-ui-decoupling-v1',
  work_packages: ['W1.2'],
  contract: 'C-01',
  started_at: new Date().toISOString(),
  node: process.version,
  invocation: {
    command: 'node --experimental-transform-types --import ./integrations/deepseek-harness/xuanling-blueprint/scripts/test-tsx-register.mjs test/blueprint/capabilities/artifact-slot-lifecycle.mjs --report-dir docs/validation/blueprint/current/w1',
    argv: process.argv.slice(2),
    reportDir: REPORT_DIR,
    reportPath: REPORT_PATH
  },
  classification: {
    stub_oracle: true,
    real_host_gate: 'not-run',
    real_host_receipt: null,
    required_host_version: '>=0.2.1-alpha.5',
    stub_green_does_not_prove_real_host: true
  },
  green: {},
  red: [],
  passed: false
}

const expectTyped = async (label, expectedCode, trigger) => {
  try {
    await trigger()
  } catch (error) {
    const observed = error instanceof ArtifactLoaderError ? error.code : 'UNEXPECTED(' + error.constructor.name + ': ' + error.message.slice(0, 140) + ')'
    const match = observed === expectedCode
    report.red.push({ label, expectedCode, observedCode: observed, match, detail: error instanceof ArtifactLoaderError ? error.detail : error.message.slice(0, 220) })
    return match
  }
  report.red.push({ label, expectedCode, observedCode: 'NO_FAILURE', match: false, detail: 'defective fixture did not fail' })
  return false
}

const syntheticClosure = ({ body, id = '@xuanling-rs/xuanling-dsh-blueprint' }) =>
  'window.__ModuleLoader__.load({ id: "' + id + '", factory(require) { var module = { exports: {} }; var exports = module.exports;\n' + body + '\nreturn module.exports; } });'

// Two seats; dispose releases only what partial says. Mirrors the real
// contribution shape (seats live on a child plugin scope).
const multiSeatClosure = ({ partial }) =>
  syntheticClosure({
    body:
      "require('react')\n" +
      "require('react/jsx-runtime')\n" +
      "require('react-dom')\n" +
      "exports.inject = ['slots', 'remote', 'locale']\n" +
      'exports.apply = async function (ctx) {\n' +
      "  var offs = []\n" +
      "  var child = ctx.plugin({ inject: ['slots'], apply: function (scope) {\n" +
      "    var slots = scope.get('slots')\n" +
      "    offs.push(slots.inject('main', function () { return slots.register({ name: 'main', key: 'xuanling-blueprint' }, function A() { return null }) }))\n" +
      "    offs.push(slots.inject('sidebar.panellist', function () { return slots.register({ name: 'sidebar.panellist', id: 'xuanling-blueprint', order: 91 }, function B() { return null }) }))\n" +
      '  }})\n' +
      '  return async function () {\n' +
      (partial ? '    if (offs[0]) offs[0]()\n' : '    if (offs[0]) offs[0]()\n    if (offs[1]) offs[1]()\n') +
      '    child.dispose()\n' +
      '  }\n' +
      '}\n'
  })

let exitCode = 0
let tempDir
try {
  const table = loadSharedRuntimeTable()
  report.green.sharedRuntime = await assertSharedRuntimeIdentity(table)

  if (!existsSync(ARTIFACT_PATH)) throw new ArtifactLoaderError('ARTIFACT_FILE_MISSING', 'committed lib/client.js missing; run the package build gate first')
  const artifact = loadClosureArtifact({ table })
  const source = await loadSourceBootstrap()

  // --- green: artifact lifecycle, three consecutive runs ---
  const artifactRuns = []
  for (let index = 0; index < REQUIRED_CONSECUTIVE_RUNS; index++) {
    artifactRuns.push(await runSlotLifecycle(artifact.plugin))
  }
  report.green.artifactLifecycle = {
    consecutiveRuns: REQUIRED_CONSECUTIVE_RUNS,
    allRunsLeakFree: artifactRuns.every(run => run.first.after.seats.length === 0 && run.first.after.registrations.length === 0),
    remountRestoresSameSeats: artifactRuns.every(
      run =>
        JSON.stringify(run.first.settled.registrations.map(entry => [entry.name, entry.id, entry.key, entry.order])) ===
        JSON.stringify(run.second.settled.registrations.map(entry => [entry.name, entry.id, entry.key, entry.order]))
    ),
    seatContract: assertSeatContract(artifactRuns[0].first.settled),
    renderedSlots: artifactRuns[0].first.renderedSlots,
    disposeTrace: artifactRuns[0].first.events.filter(event => ['inject-dispose', 'unregister', 'plugin-dispose', 'mount-dispose'].includes(event.at)),
    styleObservation: {
      note: 'canvas styles are installed once and kept after dispose (host dedupes by element id); recorded as existing behavior, not treated as a slot leak',
      installedAfterThreeApplyDisposeCycles: artifact.document.installedStyles.length
    }
  }

  // --- green: source lifecycle for the same contract ---
  const previousDocument = globalThis.document
  const installed = []
  globalThis.document = {
    documentElement: { style: {} },
    getElementById: id => installed.find(style => style.id === id) ?? null,
    createElement: tag => ({ tagName: tag, id: '', textContent: '' }),
    head: { appendChild: node => installed.push(node) }
  }
  try {
    const sourceRuns = []
    for (let index = 0; index < REQUIRED_CONSECUTIVE_RUNS; index++) {
      sourceRuns.push(await runSlotLifecycle(source.plugin))
    }
    report.green.sourceLifecycle = {
      consecutiveRuns: REQUIRED_CONSECUTIVE_RUNS,
      allRunsLeakFree: sourceRuns.every(run => run.first.after.seats.length === 0 && run.first.after.registrations.length === 0),
      seatContract: assertSeatContract(sourceRuns[0].first.settled),
      renderedSlots: sourceRuns[0].first.renderedSlots,
      disposeTrace: sourceRuns[0].first.events.filter(event => ['inject-dispose', 'unregister', 'plugin-dispose', 'mount-dispose'].includes(event.at))
    }
  } finally {
    globalThis.document = previousDocument
  }

  // --- red: typed failure contract ---
  tempDir = mkdtempSync(join(tmpdir(), 'w1-slot-red-'))
  const clonedReactRoot = join(tempDir, 'react-copy')
  const reactPackageRoot = join(REPO, 'integrations', 'deepseek-harness', 'xuanling-blueprint', 'node_modules', 'react')
  // dereference: node_modules/react is a pnpm symlink; the clone must be real
  // bytes in a separate directory to be a genuinely distinct module instance.
  cpSync(reactPackageRoot, clonedReactRoot, { recursive: true, dereference: true })
  const secondCopy = createRequire(join(clonedReactRoot, 'package.json'))(join(clonedReactRoot, 'index.js'))
  report.red = []
  const redResults = []
  redResults.push(
    await expectTyped('stub table serves a second React copy', 'ARTIFACT_REACT_IDENTITY_MISMATCH', async () => {
      const duplicated = new Map(table)
      duplicated.set('react', secondCopy)
      const reactDiagnostics = []
      const previousConsoleError = console.error
      console.error = (...parts) => reactDiagnostics.push(parts.map(item => String(item)).join(' '))
      try {
        await assertSharedRuntimeIdentity(duplicated)
      } finally {
        console.error = previousConsoleError
        report.secondReactDiagnostics = {
          invalidHookCallSignatureObserved: reactDiagnostics.some(text => text.includes('Invalid hook call') && text.includes('more than one copy of React')),
          lines: reactDiagnostics.length
        }
      }
    })
  )
  redResults.push(
    await expectTyped('production artifact embeds second React while retaining shared require', 'ARTIFACT_REACT_IDENTITY_MISMATCH', async () => {
      const requirePackage = requireFromBlueprint()
      const reactRoot = dirname(requirePackage.resolve('react'))
      const secondRuntime = readFileSync(join(reactRoot, 'cjs', 'react.production.js'), 'utf8')
      const original = readFileSync(ARTIFACT_PATH, 'utf8')
      const replacement = '(()=>{require("react"); const exports = {}; ' + secondRuntime + '; return exports;})()'
      const mutated = original.replace('require("react")', () => replacement)
      if (mutated === original) throw new Error('production React binding mutation did not apply')
      const path = join(tempDir, 'embedded-second-react.js')
      writeFileSync(path, mutated)
      const loaded = loadClosureArtifact({ table, artifactPath: path })
      // The unchanged shared table and request floor both pass. Only rendering
      // the registered production component can expose the duplicate binding.
      await assertSharedRuntimeIdentity(table)
      await runSlotLifecycle(loaded.plugin)
    })
  )
  redResults.push(
    await expectTyped('closure seat that is never unregistered', 'ARTIFACT_SLOT_LIFECYCLE_LEAK', async () => {
      const path = join(tempDir, 'leak-none.js')
      writeFileSync(path, syntheticClosure({
        body:
          "require('react')\n" +
          "exports.inject = ['slots', 'remote', 'locale']\n" +
          'exports.apply = async function (ctx) {\n' +
          "  ctx.plugin({ inject: ['slots'], apply: function (scope) {\n" +
          "    var slots = scope.get('slots')\n" +
          "    slots.inject('main', function () { return slots.register({ name: 'main', key: 'xuanling-blueprint' }, function L() { return null }) })\n" +
          '  }})\n' +
          '  return async function () {\n' +
          '  }\n' +
          '}\n'
      }))
      const loaded = loadClosureArtifact({ table, artifactPath: path, applySourceMarkers: false, applySharedRuntimeFloor: false })
      await runSlotLifecycle(loaded.plugin)
    })
  )
  redResults.push(
    await expectTyped('closure disposes only one of two seats', 'ARTIFACT_SLOT_LIFECYCLE_LEAK', async () => {
      const path = join(tempDir, 'leak-partial.js')
      writeFileSync(path, multiSeatClosure({ partial: true }))
      const loaded = loadClosureArtifact({ table, artifactPath: path, applySourceMarkers: false, applySharedRuntimeFloor: false })
      await runSlotLifecycle(loaded.plugin)
    })
  )
  {
    const leakyPath = join(tempDir, 'leak-partial.js')
    if (existsSync(leakyPath)) {
      const leaky = loadClosureArtifact({ table, artifactPath: leakyPath, applySourceMarkers: false, applySharedRuntimeFloor: false })
      report.green.legacyCoverageGap = {
        note: 'pre-W1 entry level (closure loads, exports exist) accepts a partially-leaking closure; W1.2 lifecycle oracle rejects it',
        legacyExportsOnlyCheckPassesLeakyClosure: legacyExportsOnlyCheck(leaky.plugin)
      }
    }
  }

  const redAllMatched = report.red.length > 0 && report.red.every(entry => entry.match)
  const greenClean =
    report.green.artifactLifecycle.allRunsLeakFree &&
    report.green.artifactLifecycle.remountRestoresSameSeats &&
    report.green.artifactLifecycle.seatContract.seats.length === 3 &&
    report.green.sourceLifecycle.allRunsLeakFree &&
    report.green.sourceLifecycle.seatContract.seats.length === 3 &&
    report.green.legacyCoverageGap?.legacyExportsOnlyCheckPassesLeakyClosure === true
  report.passed = greenClean && redAllMatched
  report.finished_at = new Date().toISOString()
  if (!report.passed) exitCode = 1
} catch (error) {
  report.passed = false
  report.finished_at = new Date().toISOString()
  report.fatal = error instanceof ArtifactLoaderError ? { code: error.code, detail: error.detail } : { code: 'UNEXPECTED', detail: error.stack?.slice(0, 800) ?? String(error) }
  exitCode = 1
} finally {
  try {
    mkdirSync(REPORT_DIR, { recursive: true })
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n')
  } catch (writeError) {
    console.error('report write failed:', writeError.message)
    exitCode = exitCode || 1
  }
  if (tempDir && typeof tempDir === 'string' && tempDir.startsWith(join(tmpdir(), 'w1-slot-red-'))) {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  }
}

console.log('W1.2 shared-React identity + slot disposal oracle: ' + (report.passed ? 'PASS' : 'FAIL'))
console.log('  react=' + (report.green?.sharedRuntime?.reactVersion ?? 'n/a') + ' probe=' + (report.green?.sharedRuntime?.probe ?? 'n/a'))
console.log('  artifact lifecycle runs=' + (report.green?.artifactLifecycle?.consecutiveRuns ?? 0) + ' seats=' + JSON.stringify(report.green?.artifactLifecycle?.seatContract?.seats ?? []))
console.log('  source lifecycle runs=' + (report.green?.sourceLifecycle?.consecutiveRuns ?? 0) + ' seats=' + JSON.stringify(report.green?.sourceLifecycle?.seatContract?.seats ?? []))
for (const entry of report.red ?? []) console.log('  red[' + (entry.match ? 'ok' : 'MISS') + '] ' + entry.label + ' -> ' + entry.observedCode)
console.log('  report=' + REPORT_PATH)
process.exit(exitCode)
