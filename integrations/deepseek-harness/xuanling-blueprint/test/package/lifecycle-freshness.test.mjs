// Public PK1 collector regressions. Every repo, artifact and receipt here is
// synthetic and disposable: green calibrates the collector, never real
// lifecycle, provider/live, or OS acceptance. No evaluator-private imports.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { getCases } from './package.mjs'

const PLAN_ID = 'dsh-blueprint-takeover-v1'
const MODES = ['web', 'headless']
const IDS = ['PL1', 'PL2', 'PL3', 'PL4', 'PL5', 'PL6', 'PL7']
// Independent public-contract oracle; never derived from the implementation.
const FLAGS = {
  PL1: ['packed'],
  PL2: ['profileInitialized'],
  PL3: ['installed', 'reconciled'],
  PL4: ['booted', 'blueprintPingSucceeded'],
  PL5: ['disabled', 'uninstalled'],
  PL6: ['baselineBundlesPreserved'],
  PL7: ['sourceUntouched', 'runtimeDataUntouched']
}
// Canonical synthetic hashes, not claims about the actual checkout/artifacts.
const FINGERPRINT = { revision: '1'.repeat(40), source_sha256: '2'.repeat(64), artifact_sha256: '3'.repeat(64) }
const CANARY = ['BP', 'SECRET', 'CANARY', 'PK1', 'RAW'].join('_')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const within = (root, path) => {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel)
}
const childEnv = home => {
  const env = { HOME: home }
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return env
}

function receipt(mode, artifact, repeat = 1) {
  const time = new Date().toISOString()
  return {
    schema_version: 1,
    plan_id: PLAN_ID,
    suite: 'lifecycle',
    scope: mode,
    mode,
    repeat,
    passed: true,
    clean_acceptance_count: repeat,
    started_at: time,
    finished_at: time,
    duration_ms: 0,
    environment: { platform: `${process.platform}/${process.arch}` },
    evidence_fingerprint: structuredClone(FINGERPRINT),
    evidence_fingerprint_after: structuredClone(FINGERPRINT),
    artifacts: { tarball: { path: `${mode}.tgz`, sha256: artifact.sha256 } },
    runs: Array.from({ length: repeat }, (_, index) => ({
      index: index + 1,
      passed: true,
      clean_acceptance_count: index + 1,
      started_at: time,
      finished_at: time,
      duration_ms: 0,
      evidence_fingerprint: structuredClone(FINGERPRINT),
      evidence_fingerprint_after: structuredClone(FINGERPRINT),
      results: IDS.map(id => ({
        id,
        title: `synthetic collector-only ${id}`,
        expect: 'pass',
        status: 'pass',
        detail: { ok: true, mode, artifact_sha256: artifact.sha256, behavior_assertions: Object.fromEntries(FLAGS[id].map(flag => [flag, true])) }
      }))
    }))
  }
}

function containsCanary(value, canary, seen = new Set()) {
  if (typeof value === 'string') return value.includes(canary)
  if (Buffer.isBuffer(value)) return value.toString('utf8').includes(canary)
  if (!value || typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  return Object.values(Object.getOwnPropertyDescriptors(value)).some(
    descriptor => Object.hasOwn(descriptor, 'value') && containsCanary(descriptor.value, canary, seen)
  )
}

function fixture(t, { mutate, targetMode = 'web', exitCode = 0, output = 'receipt', raw = false, exception = false, repeat = 1 } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bp-pk1-freshness-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'integrations', 'deepseek-harness', 'xuanling-blueprint')
  const probeRoot = join(root, 'test', 'blueprint')
  const reportDir = join(root, 'fresh receipts')
  const legacyDir = join(probeRoot, 'reports', 'w8')
  const callsPath = join(root, 'collector-calls.json')
  const specPath = join(root, 'collector-fixture.json')
  const scriptPath = join(probeRoot, 'capabilities', 'lifecycle.mjs')
  for (const path of [join(packageRoot, 'lib'), join(probeRoot, 'capabilities'), reportDir, legacyDir, join(root, 'synthetic artifacts')])
    mkdirSync(path, { recursive: true })
  writeFileSync(join(packageRoot, 'lib', 'index.js'), 'export default function SyntheticFixtureOnly() {}\n')
  const artifacts = Object.fromEntries(
    MODES.map(mode => {
      const path = join(root, 'synthetic artifacts', `${mode}.tgz`)
      const bytes = Buffer.from(`SYNTHETIC COLLECTOR UNIT BYTES ONLY\n${mode}\n`)
      writeFileSync(path, bytes)
      writeFileSync(join(legacyDir, `${mode}.tgz`), bytes)
      return [mode, { path, sha256: hash(bytes) }]
    })
  )
  const receipts = Object.fromEntries(MODES.map(mode => [mode, receipt(mode, artifacts[mode], repeat)]))
  const legacy = {
    probe: 'synthetic historical green only',
    artifacts: { tarball: { sha256: 'a'.repeat(64) } },
    assertions: IDS.map(id => ({ id, passed: true }))
  }
  const legacyPath = join(legacyDir, 'w8.lifecycle-report.json')
  writeFileSync(legacyPath, JSON.stringify(legacy))
  // Seed both complete v1 histories as well: neither is this invocation's receipt.
  for (const mode of MODES) writeFileSync(join(legacyDir, `w8.lifecycle-${mode}-report.json`), JSON.stringify(receipts[mode]))
  if (mutate) mutate(receipts[targetMode], { artifacts, receipts, root, legacy })
  const outputs = Object.fromEntries(MODES.map(mode => [mode, receipts[mode]]))
  if (output === 'none') outputs[targetMode] = null
  if (output === 'legacy') outputs[targetMode] = legacy
  if (output === 'malformed-json') outputs[targetMode] = '{ malformed synthetic receipt'
  writeFileSync(specPath, JSON.stringify({ outputs, artifacts, targetMode, exitCode, raw, exception }))
  // This subprocess only implements the documented CLI/report boundary. It
  // never imports the real capability or starts DSH, npm, a provider or a build.
  writeFileSync(
    scriptPath,
    `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
const root = ${JSON.stringify(root)};
const callsPath = ${JSON.stringify(callsPath)};
const spec = JSON.parse(readFileSync(${JSON.stringify(specPath)}, 'utf8'));
const option = name => { const args = process.argv.slice(2); const equal = args.find(arg => arg.startsWith(name + '=')); if (equal) return equal.slice(name.length + 1); const index = args.indexOf(name); return index < 0 ? null : args[index + 1] ?? null; };
const mode = option('--mode'), reportDir = option('--report-dir'), planId = option('--plan-id');
const selected = ['web', 'headless'].includes(mode) ? mode : 'web';
const rel = reportDir && relative(root, resolve(reportDir));
const safe = !!reportDir && isAbsolute(reportDir) && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
const calls = existsSync(callsPath) ? JSON.parse(readFileSync(callsPath, 'utf8')) : [];
const call = { mode, reportDir, planId, safe, receiptWritten: false, artifactWritten: false, selectedExit: selected === spec.targetMode ? spec.exitCode : 0 };
if (spec.raw && selected === spec.targetMode) { process.stdout.write(${JSON.stringify(CANARY)} + '\\n'); process.stderr.write(${JSON.stringify(CANARY)} + '\\n'); }
if (mode && safe && planId && spec.outputs[selected] !== null) {
  mkdirSync(reportDir, { recursive: true });
  const value = spec.outputs[selected];
  writeFileSync(join(reportDir, mode + '.tgz'), readFileSync(spec.artifacts[selected].path));
  call.artifactWritten = true;
  writeFileSync(join(reportDir, 'w8.lifecycle-' + mode + '-report.json'), typeof value === 'string' ? value : JSON.stringify(value));
  call.receiptWritten = true;
}
calls.push(call);
writeFileSync(callsPath, JSON.stringify(calls));
if (spec.exception && selected === spec.targetMode) throw new Error(${JSON.stringify(CANARY)});
process.exit(selected === spec.targetMode ? spec.exitCode : 0);
`
  )
  return {
    root,
    reportDir,
    legacyDir,
    legacyPath,
    artifacts,
    receipts,
    callsPath,
    scriptPath,
    helpers: { packageRoot, repoRoot: root, reportDir, planId: PLAN_ID, evidenceFingerprint: structuredClone(FINGERPRINT) }
  }
}

async function invoke(f) {
  assert.equal(existsSync(join(f.helpers.packageRoot, 'lib', 'index.js')), true, 'fixture must not fail on missing lib')
  const cases = await getCases(f.helpers)
  const pk1 = cases.find(c => c.id === 'PK1')
  assert.equal(typeof pk1?.run, 'function', 'public package suite must expose PK1.run')
  try {
    return { value: await pk1.run() }
  } catch (error) {
    return { error }
  }
}

function assertInvocation(f, mode) {
  const calls = JSON.parse(readFileSync(f.callsPath, 'utf8'))
  const matches = calls.filter(value => value.mode === mode)
  assert.equal(matches.length, 1, `collector must actually run ${mode} exactly once`)
  const call = matches[0]
  assert.equal(call.planId, PLAN_ID, 'collector CLI must receive the current explicit plan')
  assert.equal(isAbsolute(call.reportDir), true, 'collector CLI must receive a resolved fresh report directory')
  assert.equal(call.safe, true, 'fixture receipts must stay within its own disposable repo')
  assert.equal(within(f.reportDir, call.reportDir), true, 'collector must honor helpers.reportDir')
  assert.equal(within(f.legacyDir, call.reportDir), false, 'collector must not reuse the historical report directory')
  return call
}

function assertNoRaw(outcome) {
  assert.equal(containsCanary(outcome, CANARY), false, 'public PK1 must not expose synthetic raw output/exception material')
}

async function expectFailure(f, { code = 'LIFECYCLE_RECEIPT_INVALID', mode = 'web' } = {}) {
  const outcome = await invoke(f)
  assertNoRaw(outcome)
  assert.equal(outcome.error instanceof Error, true, 'PK1 accepted invalid lifecycle evidence instead of rejecting it')
  assert.equal(outcome.error.code, code, 'PK1 must preserve the contracted failure classification')
  assertInvocation(f, mode)
}

function processPreflight(f, mode, expectedExit) {
  // A syntax/import/fixture failure is not the historical-green acceptance red.
  const child = spawnSync(process.execPath, [f.scriptPath, '--mode', mode, '--report-dir', join(f.root, 'preflight receipts'), '--plan-id', PLAN_ID], {
    cwd: f.root,
    env: childEnv(f.root)
  })
  assert.equal(child.error === undefined, true, 'synthetic collector must actually launch')
  assert.equal(child.signal, null, 'synthetic collector must exit normally')
  assert.equal(child.status, expectedExit, 'fixture preflight must reach its intended exit')
  writeFileSync(f.callsPath, '[]')
}

// Also isolate the caller to detect accidental forwarding of child stdout /
// stderr, not just raw material attached to a returned Error/cause/stack.
function outerInvoke(f) {
  const hostPath = join(f.root, 'public-pk1-host.mjs')
  writeFileSync(
    hostPath,
    `
import { getCases } from ${JSON.stringify(new URL('./package.mjs', import.meta.url).href)};
const containsCanary = ${containsCanary.toString()};
const helpers = ${JSON.stringify(f.helpers)};
const canary = ${JSON.stringify(CANARY)};
const allowedCodes = ['LIFECYCLE_PROCESS_FAILED', 'LIFECYCLE_RECEIPT_INVALID'];
let result;
try {
  const pk1 = (await getCases(helpers)).find(c => c.id === 'PK1');
  const value = await pk1.run();
  result = { ok: value?.ok === true, code: null, rawLeaked: containsCanary(value, canary) };
} catch (error) {
  result = { ok: false, code: allowedCodes.includes(error.code) ? error.code : 'UNEXPECTED_CODE', rawLeaked: containsCanary(error, canary) };
}
process.stdout.write(JSON.stringify(result));
`
  )
  const child = spawnSync(process.execPath, [hostPath], { cwd: f.root, env: childEnv(f.root), encoding: 'utf8' })
  assertNoRaw(child)
  assert.equal(child.error === undefined, true, 'outer public caller must launch')
  assert.equal(child.signal, null)
  assert.equal(child.status, 0, 'outer caller must classify the result rather than crash')
  assert.equal(child.stderr, '', 'public collector must not forward child stderr')
  return JSON.parse(child.stdout)
}

for (const mode of MODES) {
  test(`PK1 ${mode}: child exit 9 cannot use historical green receipts`, async t => {
    const f = fixture(t, { targetMode: mode, exitCode: 9, output: 'none' })
    processPreflight(f, mode, 9)
    await expectFailure(f, { code: 'LIFECYCLE_PROCESS_FAILED', mode })
  })
  test(`PK1 ${mode}: exit 9 rejects even a freshly written all-green receipt`, async t => {
    await expectFailure(fixture(t, { targetMode: mode, exitCode: 9 }), { code: 'LIFECYCLE_PROCESS_FAILED', mode })
  })
  test(`PK1 ${mode}: exit 0 without fresh receipt cannot use old v1 or legacy green`, async t => {
    const f = fixture(t, { targetMode: mode, output: 'none' })
    await expectFailure(f, { code: 'LIFECYCLE_RECEIPT_MISSING', mode })
    assert.equal(assertInvocation(f, mode).selectedExit, 0)
    assert.equal(assertInvocation(f, mode).receiptWritten, false)
  })
  for (const output of ['legacy', 'malformed-json']) {
    test(`PK1 ${mode}: fresh ${output} receipt is not v1 evidence`, async t => {
      await expectFailure(fixture(t, { targetMode: mode, output }), { mode })
    })
  }

  const invalidEnvelopes = [
    [
      'wrong schema',
      r => {
        r.schema_version = 2
      }
    ],
    [
      'missing schema',
      r => {
        delete r.schema_version
      }
    ],
    [
      'wrong plan',
      r => {
        r.plan_id = 'different-plan'
      }
    ],
    [
      'missing plan',
      r => {
        delete r.plan_id
      }
    ],
    [
      'wrong suite',
      r => {
        r.suite = 'package'
      }
    ],
    [
      'wrong scope',
      r => {
        r.scope = mode === 'web' ? 'headless' : 'web'
      }
    ],
    [
      'wrong mode',
      r => {
        r.mode = mode === 'web' ? 'headless' : 'web'
      }
    ],
    [
      'missing mode',
      r => {
        delete r.mode
      }
    ],
    [
      'missing environment',
      r => {
        delete r.environment
      }
    ],
    [
      'wrong environment',
      r => {
        r.environment.platform = 'invented/arch'
      }
    ],
    [
      'missing original fingerprint',
      r => {
        delete r.evidence_fingerprint
      }
    ],
    [
      'missing after fingerprint',
      r => {
        delete r.evidence_fingerprint_after
      }
    ],
    [
      'wrong original fingerprint',
      r => {
        r.evidence_fingerprint.source_sha256 = '4'.repeat(64)
      }
    ],
    [
      'top-level fingerprint drift',
      r => {
        r.evidence_fingerprint_after.artifact_sha256 = '4'.repeat(64)
      }
    ],
    [
      'stable but stale fingerprints',
      r => {
        for (const entry of [r, ...r.runs]) for (const key of ['evidence_fingerprint', 'evidence_fingerprint_after']) entry[key].source_sha256 = '4'.repeat(64)
      }
    ],
    [
      'wrong run original fingerprint',
      r => {
        r.runs[0].evidence_fingerprint.revision = '4'.repeat(40)
      }
    ],
    [
      'run fingerprint drift',
      r => {
        r.runs[0].evidence_fingerprint_after.source_sha256 = '4'.repeat(64)
      }
    ],
    [
      'false top-level passed',
      r => {
        r.passed = false
      }
    ],
    [
      'truthy top-level passed',
      r => {
        r.passed = 'true'
      }
    ],
    [
      'empty runs with top-level passed',
      r => {
        r.runs = []
      }
    ],
    [
      'empty results with top-level passed',
      r => {
        r.runs[0].results = []
      }
    ],
    [
      'zero repeat',
      r => {
        r.repeat = 0
      }
    ],
    [
      'repeat/run length mismatch',
      r => {
        r.repeat = 2
        r.clean_acceptance_count = 2
      }
    ],
    [
      'wrong report clean count',
      r => {
        r.clean_acceptance_count = 0
      }
    ],
    [
      'wrong run clean count',
      r => {
        r.runs[0].clean_acceptance_count = 0
      }
    ],
    [
      'non-contiguous run index',
      r => {
        r.runs[0].index = 2
      }
    ]
  ]
  for (const [label, mutate] of invalidEnvelopes) {
    test(`PK1 ${mode}: reject ${label}`, async t => {
      await expectFailure(fixture(t, { targetMode: mode, mutate }), { mode })
    })
  }

  for (const id of IDS) {
    test(`PK1 ${mode}: missing required ${id} cannot be hidden by top-level passed`, async t => {
      await expectFailure(
        fixture(t, {
          targetMode: mode,
          mutate: r => {
            r.runs[0].results = r.runs[0].results.filter(result => result.id !== id)
          }
        }),
        { mode }
      )
    })
    for (const field of ['id', 'expect', 'status', 'detail']) {
      test(`PK1 ${mode}: ${id} missing ${field} is not a valid pass result`, async t => {
        await expectFailure(
          fixture(t, {
            targetMode: mode,
            mutate: r => {
              delete r.runs[0].results.find(result => result.id === id)[field]
            }
          }),
          { code: 'LIFECYCLE_BEHAVIOR_INVALID', mode }
        )
      })
    }
    for (const flag of FLAGS[id]) {
      for (const variant of ['missing', 'false', 'truthy']) {
        test(`PK1 ${mode}: ${id}.${flag} ${variant} is not behavior evidence`, async t => {
          await expectFailure(
            fixture(t, {
              targetMode: mode,
              mutate: r => {
                const facts = r.runs[0].results.find(result => result.id === id).detail.behavior_assertions
                if (variant === 'missing') delete facts[flag]
                else facts[flag] = variant === 'false' ? false : 'true'
              }
            }),
            { code: 'LIFECYCLE_BEHAVIOR_INVALID', mode }
          )
        })
      }
    }
  }

  const invalidBehaviors = [
    [
      'duplicate PL ID',
      r => {
        r.runs[0].results[6] = structuredClone(r.runs[0].results[0])
      }
    ],
    [
      'unknown PL ID',
      r => {
        r.runs[0].results[6].id = 'PL8'
      }
    ],
    [
      'expected-red classification',
      r => {
        r.runs[0].results[0].expect = 'expected-red'
      }
    ],
    [
      'wrong detail mode',
      r => {
        r.runs[0].results[3].detail.mode = mode === 'web' ? 'headless' : 'web'
      }
    ],
    [
      'wrong detail artifact hash',
      r => {
        r.runs[0].results[3].detail.artifact_sha256 = '4'.repeat(64)
      }
    ],
    [
      'import-only detail',
      r => {
        r.runs[0].results[3].detail = 'ready/import-only'
      }
    ],
    [
      'forged case-level assertions',
      r => {
        const result = r.runs[0].results[3]
        result.behavior_assertions = result.detail.behavior_assertions
        result.detail = { ok: true, mode, artifact_sha256: r.artifacts.tarball.sha256 }
      }
    ],
    [
      'forged report-level assertions',
      r => {
        r.behavior_assertions = { booted: true, blueprintPingSucceeded: true }
        delete r.runs[0].results[3].detail.behavior_assertions
      }
    ]
  ]
  for (const [label, mutate] of invalidBehaviors) {
    test(`PK1 ${mode}: reject ${label}`, async t => {
      await expectFailure(fixture(t, { targetMode: mode, mutate }), { code: 'LIFECYCLE_BEHAVIOR_INVALID', mode })
    })
  }

  for (const [label, mutate, code] of [
    [
      'earlier failed run hidden by final green',
      r => {
        r.runs[0].passed = false
      },
      'LIFECYCLE_RECEIPT_INVALID'
    ],
    [
      'earlier failed result hidden by run/top-level green',
      r => {
        r.runs[0].results[3].status = 'fail'
      },
      'LIFECYCLE_BEHAVIOR_INVALID'
    ],
    [
      'earlier not-run result hidden by run/top-level green',
      r => {
        r.runs[0].results[3].status = 'not-run'
      },
      'LIFECYCLE_BEHAVIOR_INVALID'
    ],
    [
      'earlier clean-count reset hidden by final green',
      r => {
        r.runs[0].clean_acceptance_count = 0
      },
      'LIFECYCLE_RECEIPT_INVALID'
    ],
    [
      'earlier fingerprint drift hidden by final green',
      r => {
        r.runs[0].evidence_fingerprint_after.source_sha256 = '4'.repeat(64)
      },
      'LIFECYCLE_RECEIPT_INVALID'
    ]
  ]) {
    test(`PK1 ${mode}: reject ${label}`, async t => {
      await expectFailure(fixture(t, { targetMode: mode, repeat: 2, mutate }), { code, mode })
    })
  }

  test(`PK1 ${mode}: tarball byte tamper fails even when every declared hash agrees`, async t => {
    const f = fixture(t, {
      targetMode: mode,
      mutate: (r, { artifacts }) => {
        writeFileSync(artifacts[mode].path, 'SYNTHETIC TAMPERED BYTES; DECLARED HASH UNCHANGED\n')
        assert.equal(
          r.runs.every(run => run.results.every(result => result.detail.artifact_sha256 === r.artifacts.tarball.sha256)),
          true
        )
        assert.notEqual(hash(readFileSync(artifacts[mode].path)), r.artifacts.tarball.sha256)
      }
    })
    await expectFailure(f, { code: 'LIFECYCLE_ARTIFACT_INVALID', mode })
    const call = assertInvocation(f, mode)
    assert.equal(
      hash(readFileSync(join(call.reportDir, `${mode}.tgz`))),
      hash(readFileSync(f.artifacts[mode].path)),
      'child must actually write the tampered bytes'
    )
  })
  test(`PK1 ${mode}: mutually consistent forged hashes cannot replace actual tarball bytes`, async t => {
    await expectFailure(
      fixture(t, {
        targetMode: mode,
        mutate: r => {
          r.artifacts.tarball.sha256 = '4'.repeat(64)
          for (const run of r.runs) for (const result of run.results) result.detail.artifact_sha256 = r.artifacts.tarball.sha256
        }
      }),
      { code: 'LIFECYCLE_ARTIFACT_INVALID', mode }
    )
  })

  for (const exception of [false, true]) {
    test(`PK1 ${mode}: malicious child ${exception ? 'exception' : 'stdout/stderr'} is not exposed`, t => {
      const f = fixture(t, { targetMode: mode, exitCode: exception ? 0 : 9, raw: true, exception })
      const outcome = outerInvoke(f)
      assert.deepEqual(outcome, { ok: false, code: 'LIFECYCLE_PROCESS_FAILED', rawLeaked: false })
      assertInvocation(f, mode)
    })
  }
  test(`PK1 ${mode}: malformed receipt with raw fields is safely classified`, t => {
    const f = fixture(t, {
      targetMode: mode,
      raw: true,
      mutate: r => {
        r.plan_id = CANARY
        r.raw_error = CANARY
      }
    })
    assert.deepEqual(outerInvoke(f), { ok: false, code: 'LIFECYCLE_RECEIPT_INVALID', rawLeaked: false })
    assertInvocation(f, mode)
  })
}

for (const repeat of [1, 3]) {
  test(`PK1: synthetic v1 web + headless x${repeat} calibrates only the public collector`, async t => {
    const f = fixture(t, { repeat })
    const outcome = await invoke(f)
    assertNoRaw(outcome)
    assert.equal(outcome.error === undefined, true, 'complete synthetic v1 receipts must calibrate the public collector')
    assert.equal(outcome.value?.ok, true)
    const calls = MODES.map(mode => assertInvocation(f, mode))
    assert.equal(JSON.parse(readFileSync(f.callsPath, 'utf8')).length, 2, 'both modes must actually be collected')
    assert.notEqual(calls[0].reportDir, calls[1].reportDir, 'the modes must have distinct fresh report directories')
    for (const call of calls) {
      assert.equal(call.selectedExit, 0)
      assert.equal(call.receiptWritten, true)
      assert.equal(call.artifactWritten, true)
      const bytes = readFileSync(join(call.reportDir, `${call.mode}.tgz`))
      assert.equal(hash(bytes), f.artifacts[call.mode].sha256)
      const r = JSON.parse(readFileSync(join(call.reportDir, `w8.lifecycle-${call.mode}-report.json`), 'utf8'))
      assert.deepEqual(r, f.receipts[call.mode], 'child must write the intended public v1 receipt, not a substitute')
    }
  })
}
