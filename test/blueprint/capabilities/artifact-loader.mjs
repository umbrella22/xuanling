#!/usr/bin/env node
// W1.1 source-vs-lib loader fixture runner (plan_id dsh-blueprint-ui-decoupling-v1,
// contract C-01, work packages W1.1).
//
// Green direction: the SAME built lib/client.js closure real DSH hosts
// serve, and the src/client/index.ts bootstrap, both pass the shared
// ModuleLoader harness: exactly one registration, factory requests only the
// shared runtime table (react, react/jsx-runtime, react-dom floor), apply/inject
// exports present, C-01 seat contract satisfied, apply/dispose lifecycle clean,
// remount restores the same descriptors.
//
// Red direction (self-proving oracle): each defective closure below must fail
// with exactly the recorded typed code. Missing file, broken registration,
// missing export, unknown module request, stub table with an omitted runtime,
// folded-in second runtime (floor) and a slot-less closure are all covered.
// The pre-W1 "exports exist only" coverage level is recorded against the
// slot-less closure to show the gap this oracle closes.
//
// Stub oracle only: green here is NOT real host evidence; see classification.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  ARTIFACT_PATH,
  ArtifactLoaderError,
  PACKAGE_ID,
  REPO,
  SHARED_RUNTIME_IDS,
  assertSeatContract,
  assertSharedRuntimeIdentity,
  legacyExportsOnlyCheck,
  loadClosureArtifact,
  loadSharedRuntimeTable,
  loadSourceBootstrap,
  runSlotLifecycle,
  sha256File
} from './artifact-loader-fixture.mjs'

const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(name)
  return index >= 0 ? resolve(args[index + 1]) : undefined
}
const REPORT_DIR = option('--report-dir') ?? join(REPO, 'docs', 'validation', 'blueprint', 'current', 'w1')
const REPORT_PATH = join(REPORT_DIR, 'w1.1-artifact-loader-report.json')

const report = {
  probe: 'w1.1-source-vs-artifact-loader',
  plan_id: 'dsh-blueprint-ui-decoupling-v1',
  work_packages: ['W1.1'],
  contract: 'C-01',
  started_at: new Date().toISOString(),
  node: process.version,
  invocation: {
    command: 'node --experimental-transform-types --import ./integrations/deepseek-harness/xuanling-blueprint/scripts/test-tsx-register.mjs test/blueprint/capabilities/artifact-loader.mjs --report-dir docs/validation/blueprint/current/w1',
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
    const observed = error instanceof ArtifactLoaderError ? error.code : `UNEXPECTED(${error.constructor.name}: ${error.message.slice(0, 140)})`
    const match = observed === expectedCode
    report.red.push({ label, expectedCode, observedCode: observed, match, detail: error instanceof ArtifactLoaderError ? error.detail : error.message.slice(0, 200) })
    return match
  }
  report.red.push({ label, expectedCode, observedCode: 'NO_FAILURE', match: false, detail: 'defective fixture did not fail' })
  return false
}

// Official closure-factory format used by the vite client pack banner/footer.
const syntheticClosure = ({ body, id = PACKAGE_ID }) =>
  `window.__ModuleLoader__.load({ id: '${id}', factory(require) { var module = { exports: {} }; var exports = module.exports;\n${body}\nreturn module.exports; } });`

const sealantPlugin = ({ leaky, registers }) => {
  const seatLines = registers
    ? "  var off = null\n" +
      "  var child = ctx.plugin({ inject: ['slots'], apply: function (scope) {\n" +
      "    var slots = scope.get('slots')\n" +
      "    off = slots.inject('main', function () { return slots.register({ name: 'main', key: 'xuanling-blueprint' }, function Sealant() { return null }) })\n" +
      "  }})\n"
    : ''
  const disposeLines = registers && !leaky ? '    if (off) off()\n    child.dispose()\n' : ''
  return (
    "require('react')\n" +
    "require('react/jsx-runtime')\n" +
    "require('react-dom')\n" +
    "exports.inject = ['slots', 'remote', 'locale']\n" +
    'exports.apply = async function (ctx) {\n' +
    seatLines +
    '  return async function () {\n' +
    disposeLines +
    '  }\n' +
    '}\n'
  )
}

const writeTampered = (tempDir, name, text) => {
  const path = join(tempDir, name)
  writeFileSync(path, text)
  return path
}

const stripFirst = (text, pattern, replacement) => {
  const index = text.search(pattern)
  if (index < 0) throw new Error('tamper pattern not found')
  return text.slice(0, index) + text.slice(index).replace(pattern, replacement)
}

let exitCode = 0
let tempDir
try {
  const table = loadSharedRuntimeTable()
  report.green.sharedRuntime = await assertSharedRuntimeIdentity(table)

  // --- green: the committed artifact, the exact bytes real hosts serve ---
  if (!existsSync(ARTIFACT_PATH)) throw new ArtifactLoaderError('ARTIFACT_FILE_MISSING', 'committed lib/client.js missing; run the package build gate first')
  const artifact = loadClosureArtifact({ table })
  report.green.artifact = {
    path: artifact.artifactPath,
    sha256: artifact.artifactSha256,
    bytes: artifact.artifactBytes,
    registeredId: artifact.id,
    requestSequence: artifact.requested,
    requestSet: artifact.requestSet,
    sharedRuntimeIdsOfferedByStub: SHARED_RUNTIME_IDS
  }
  const artifactLifecycle = await runSlotLifecycle(artifact.plugin)
  report.green.artifactSeat = assertSeatContract(artifactLifecycle.first.settled)
  report.green.artifactLifecycle = {
    renderedSlots: artifactLifecycle.first.renderedSlots,
    firstDisposing: artifactLifecycle.first.after.seats.length === 0 && artifactLifecycle.first.after.registrations.length === 0,
    remountRestoresSameSeats:
      artifactLifecycle.second &&
      JSON.stringify(artifactLifecycle.first.settled.registrations.map(entry => [entry.name, entry.id, entry.key, entry.order])) ===
        JSON.stringify(artifactLifecycle.second.settled.registrations.map(entry => [entry.name, entry.id, entry.key, entry.order]))
  }

  // --- green: the source bootstrap through the same contract ---
  const source = await loadSourceBootstrap()
  const sourceLifecycle = await runSlotLifecycle(source.plugin)
  report.green.source = {
    path: source.sourcePath,
    renderedSlots: sourceLifecycle.first.renderedSlots,
    inject: source.plugin.inject
  }
  report.green.sourceSeat = assertSeatContract(sourceLifecycle.first.settled)

  // --- parity: source entry and built artifact expose the same contract ---
  report.green.parity = {
    injectIdentical: JSON.stringify(source.plugin.inject) === JSON.stringify(artifact.plugin.inject),
    seatsIdentical:
      JSON.stringify(report.green.artifactSeat.seats) === JSON.stringify(report.green.sourceSeat.seats),
    registrationDescriptorsIdentical:
      JSON.stringify(artifactLifecycle.first.settled.registrations) === JSON.stringify(sourceLifecycle.first.settled.registrations),
    contract: 'src/client/index.ts and lib/client.js both satisfy C-01 through one harness'
  }

  // --- artifact provenance observation (not a gate) ---
  const libDir = join(REPO, 'integrations', 'deepseek-harness', 'xuanling-blueprint', 'lib')
  const libHashes = existsSync(libDir)
    ? Object.fromEntries(readdirSync(libDir).filter(name => name.endsWith('.js')).map(name => [name, sha256File(join(libDir, name))]))
    : {}
  report.green.artifactProvenance = {
    note: 'vp pack chunk names/hashes are not byte-deterministic; freshness is asserted via SOURCE_MARKERS in the bundle',
    sourceMarkersChecked: true,
    libFileHashes: libHashes,
    w0RecordedFreshHash: 'd6f4c731883e806cd0228211c94eb0bb4d975cb511a3bc432d5100c65ab8dd67',
    w0HashMatchesCurrentLibFile: Object.values(libHashes).includes('d6f4c731883e806cd0228211c94eb0bb4d975cb511a3bc432d5100c65ab8dd67')
  }

  // --- red: typed failure contract ---
  const closure = readFileSync(ARTIFACT_PATH, 'utf8')
  tempDir = mkdtempSync(join(tmpdir(), 'w1-loader-red-'))
  const tableWithoutJsxRuntime = new Map(table)
  tableWithoutJsxRuntime.delete('react/jsx-runtime')

  report.red = []
  const redResults = []
  redResults.push(await expectTyped('missing artifact file', 'ARTIFACT_FILE_MISSING', async () => {
    loadClosureArtifact({ table, artifactPath: join(tempDir, 'client.missing.js') })
  }))
  redResults.push(await expectTyped('closure without __ModuleLoader__ registration', 'ARTIFACT_REGISTRATION_INVALID', async () => {
    const path = writeTampered(tempDir, 'no-registration.js', closure.replace(/^window\.__ModuleLoader__\.load\(/, 'void 0;('))
    loadClosureArtifact({ table, artifactPath: path, applySourceMarkers: false })
  }))
  redResults.push(await expectTyped('closure without apply export', 'ARTIFACT_EXPORT_CONTRACT_INVALID', async () => {
    const path = writeTampered(tempDir, 'no-apply.js', stripFirst(closure, /exports\.apply=[A-Za-z_$][\w$]*,/, ''))
    loadClosureArtifact({ table, artifactPath: path, applySourceMarkers: false })
  }))
  redResults.push(await expectTyped('factory requests module outside the shared table', 'ARTIFACT_REQUEST_OUTSIDE_SHARED_TABLE', async () => {
    const path = writeTampered(tempDir, 'outside-table.js', closure.replace('require("react")', '(require("react"),require("react/no-such-subpath"))'))
    loadClosureArtifact({ table, artifactPath: path, applySourceMarkers: false })
  }))
  redResults.push(await expectTyped('stub loader omits react/jsx-runtime', 'ARTIFACT_MODULE_MISSING', async () => {
    loadClosureArtifact({ table: tableWithoutJsxRuntime, artifactPath: ARTIFACT_PATH, applySourceMarkers: false })
  }))
  redResults.push(await expectTyped('closure without shared runtime requests (second runtime floor)', 'ARTIFACT_SHARED_RUNTIME_NOT_REQUESTED', async () => {
    const path = writeTampered(tempDir, 'second-runtime.js', syntheticClosure({ body: sealantPlugin({ leaky: false, registers: true }).replace("require('react/jsx-runtime')", '').replace("require('react-dom')", '') }))
    loadClosureArtifact({ table, artifactPath: path, applySourceMarkers: false })
  }))
  redResults.push(await expectTyped('closure registers no slot (missing seat)', 'ARTIFACT_SEAT_CONTRACT_MISMATCH', async () => {
    const path = writeTampered(tempDir, 'no-seats.js', syntheticClosure({ body: sealantPlugin({ leaky: false, registers: false }) }))
    const loaded = loadClosureArtifact({ table, artifactPath: path, applySourceMarkers: false })
    const lifecycle = await runSlotLifecycle(loaded.plugin)
    assertSeatContract(lifecycle.first.settled)
  }))
  redResults.push(await expectTyped('closure seat that never unregisters (leak)', 'ARTIFACT_SLOT_LIFECYCLE_LEAK', async () => {
    const path = writeTampered(tempDir, 'leak.js', syntheticClosure({ body: sealantPlugin({ leaky: true, registers: true }) }))
    const loaded = loadClosureArtifact({ table, artifactPath: path, applySourceMarkers: false })
    await runSlotLifecycle(loaded.plugin)
  }))

  // --- old coverage gap: pre-W1 level passes the slot-less closure ---
  const noSeatsPath = join(tempDir, 'no-seats.js')
  if (existsSync(noSeatsPath)) {
    const noSeats = loadClosureArtifact({ table, artifactPath: noSeatsPath, applySourceMarkers: false, applySharedRuntimeFloor: false })
    report.green.legacyCoverageGap = {
      note: 'pre-W1 entry level (closure loads, exports exist) accepts a closure with no slot lifecycle at all; W1.1 seat contract rejects it',
      legacyExportsOnlyCheckPassesSlotlessClosure: legacyExportsOnlyCheck(noSeats.plugin)
    }
  }

  const redAllMatched = report.red.length > 0 && report.red.every(entry => entry.match)
  const greenClean =
    report.green.artifactLifecycle.firstDisposing &&
    report.green.artifactLifecycle.remountRestoresSameSeats &&
    report.green.parity.injectIdentical &&
    report.green.parity.seatsIdentical &&
    report.green.parity.registrationDescriptorsIdentical &&
    report.green.legacyCoverageGap?.legacyExportsOnlyCheckPassesSlotlessClosure === true
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
  if (tempDir && typeof tempDir === 'string' && tempDir.startsWith(join(tmpdir(), 'w1-loader-red-'))) {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  }
}

console.log('W1.1 source-vs-artifact loader fixture: ' + (report.passed ? 'PASS' : 'FAIL'))
console.log('  artifact ' + basename(report.green?.artifact?.path ?? ARTIFACT_PATH) + ' sha256=' + (report.green?.artifact?.sha256 ?? 'n/a'))
console.log('  requests=' + JSON.stringify(report.green?.artifact?.requestSet ?? []))
console.log('  seats=' + JSON.stringify(report.green?.artifactSeat?.seats ?? []) + ' sourceSeats=' + JSON.stringify(report.green?.sourceSeat?.seats ?? []))
for (const entry of report.red ?? []) console.log('  red[' + (entry.match ? 'ok' : 'MISS') + '] ' + entry.label + ' -> ' + entry.observedCode)
console.log('  report=' + REPORT_PATH)
process.exit(exitCode)
