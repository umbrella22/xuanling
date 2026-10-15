// These are deliberately SYNTHETIC validator tests; not browser/live receipts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { deflateSync } from 'node:zlib'
import {
  PLAN_ID,
  sha256,
  validateCollectorGate,
  validateScreenshot,
  auditArtifacts
} from '../../../../../test/blueprint/capabilities/conversation-evidence.mjs'
import { conversationDomReadyForSession } from '../../../../../test/blueprint/capabilities/conversation-browser.mjs'

function syntheticReceipt(root, mode = 'live') {
  const at = new Date().toISOString(),
    fp = { revision: 'a'.repeat(40), source_sha256: 'b'.repeat(64), artifact_sha256: 'c'.repeat(64) }
  const provenance = {
    helpers: Array.from({ length: 8 }, (_, i) => ({ path: `unit-${i}`, sha256: 'd'.repeat(64) })),
    fixture: { path: '/unit-fixture.mjs', sha256: 'e'.repeat(64) }
  }
  // Synthetic scanline image for validator tests, never delivered as browser proof.
  const chunk = (kind, payload) => {
    const bytes = Buffer.alloc(payload.length + 12)
    bytes.writeUInt32BE(payload.length)
    bytes.write(kind, 4)
    payload.copy(bytes, 8)
    return bytes
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1600)
  ihdr.writeUInt32BE(1000, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(1000 * (1 + 1600 * 3)))),
    chunk('IEND', Buffer.alloc(0))
  ])
  const path = join(root, 'unit-header.png')
  writeFileSync(path, bytes)
  const image = { path, sha256: sha256(bytes), at, provenance: 'actual Playwright native Edge screenshot' }
  const source = { sessionId: 'parent', kind: mode === 'live' ? 'tool' : 'ui', callId: mode === 'live' ? 'call-unit' : null, turn: mode === 'live' ? 1 : null }
  const projection = {
    sessionId: 'child',
    runId: 'run-unit',
    revision: 'unit-frozen',
    graphSha256: 'f'.repeat(64),
    nodeIds: ['node'],
    source,
    focusAttemptIds: ['att-unit'],
    attempts: [{ attemptId: 'att-unit', sessionId: 'child', nodeId: 'node' }]
  }
  const state = { sessionId: 'child', totalCalls: 1, identities: ['child:1'], requestIdentity: 'child:1', active: true, textDeltas: 2, failed: false, at }
  const pending = {
    sessionId: 'parent',
    auditId: 'approval-unit',
    callId: 'write-unit',
    pending: true,
    outcome: null,
    askedSeq: 5,
    decidedSeq: null,
    decidedLogged: false,
    at
  }
  const cases = {
    'native-tab': { sessionId: 'parent', nativeTab: true, viewId: 'xuanling-blueprint', nestedComposers: 0 },
    'native-draft': {
      sessionId: 'parent',
      nativeComposerCount: 1,
      beforeSha256: 'a'.repeat(64),
      switchedSha256: 'a'.repeat(64),
      reloadedSha256: 'a'.repeat(64)
    },
    'refresh-attempt': { before: projection, after: projection, executionSessionEvidence: mode === 'live' },
    'frozen-graph': {
      before: projection,
      after: projection,
      definitionChanged: true,
      liveDefinitionBefore: 'old',
      liveDefinitionRevision: 'new',
      liveSemanticBefore: 'old-semantic',
      liveSemanticAfter: 'new-semantic',
      changedNodeId: 'new-node'
    },
    'plain-unbound': {
      sessionId: 'plain',
      sourceSessionId: 'parent',
      hostStatus: 'unbound',
      dom: { sessionId: 'plain', runId: null, nodes: [], attempts: [] }
    },
    'host-restart': {
      before: projection,
      after: projection,
      sourceSessionId: 'parent',
      sourceBefore: source,
      sourceAfter: source,
      runStateBefore: mode === 'live' ? 'succeeded' : 'waiting_input',
      runStateAfter: mode === 'live' ? 'succeeded' : 'waiting_input',
      executionSessionEvidence: mode === 'live',
      mutationDelta: 0
    },
    ...(mode === 'live'
      ? {
          'stream-switch-10': {
            sessionId: 'child',
            switches: Array.from({ length: 10 }, (_, i) => ({ ordinal: i + 1, before: state, after: state, mutationDelta: 0 }))
          },
          'native-approval': {
            sessionId: 'parent',
            nativeKey: 'approval:1',
            before: pending,
            identities: Array.from({ length: 10 }, () => ({ nativeKey: 'approval:1', observed: pending, mutationDelta: 0 })),
            after: { ...pending, pending: false, outcome: 'allowed-once', decidedLogged: true, decidedSeq: 6 },
            tool: { name: 'write', callId: 'write-unit', callSeq: 4, resultSeq: 9, isError: false, pipelineIsError: false, pipelineResultObserved: true },
            effect: {
              category: 'isolated-native-write',
              sha256: sha256('isolated conversation approval fixture\n'),
              bytes: Buffer.byteLength('isolated conversation approval fixture\n')
            }
          },
          'tool-lineage': {
            sessionId: 'parent',
            callId: 'call-unit',
            catalogCallId: 'list-unit',
            inspectCallId: 'inspect-unit',
            turn: 1,
            runId: 'run-unit',
            toolName: 'blueprint_start',
            nativeToolResultObserved: true
          },
          'child-artifact': {
            runId: 'run-unit',
            sessionId: 'parent',
            sourceCallId: 'call-unit',
            executionSessionId: 'child',
            attemptId: 'att-unit',
            downstreamAttemptId: 'att-downstream',
            state: 'succeeded',
            resultKind: 'succeeded',
            acceptanceCode: 'accepted',
            inputSha256: '9'.repeat(64),
            outputSha256: '9'.repeat(64),
            downstreamSha256: '9'.repeat(64)
          }
        }
      : {})
  }
  const receipt = {
    schemaVersion: 1,
    planId: PLAN_ID,
    status: 'passed',
    mode,
    installMode: 'linked',
    sessionId: 'parent',
    keyRead: false,
    pageErrors: 0,
    credentialReader: mode === 'live' ? 'isolated DSH child preload' : null,
    fingerprint: fp,
    fingerprintAfter: fp,
    provenance,
    provenanceAfter: provenance,
    startedAt: new Date(Date.now() - 1000).toISOString(),
    finishedAt: new Date(Date.now() + 1000).toISOString(),
    browser: {
      kind: 'owned native Edge CDP',
      noDefaults: true,
      defaultContext: true,
      closed: true,
      profileRemoved: true,
      pid: 123,
      profile: '/unit-owned',
      args: ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=/unit-owned']
    },
    cleanup: { hostStopped: true, isolationRemoved: true },
    package: {
      indexSha256: 'a'.repeat(64),
      clientSha256: 'b'.repeat(64),
      artifactSha256: 'c'.repeat(64),
      artifactSha256After: 'c'.repeat(64),
      artifactCount: 2
    },
    boot: {
      authenticated: true,
      pluginPing: true,
      actualBrowser: true,
      clientEntry: '@xuanling-rs/xuanling-dsh-blueprint',
      clientBundle: { status: 200, closure: true }
    },
    steps: [
      { id: 'version', passed: true, exitCode: 0 },
      { id: 'linked-profile', passed: true },
      { id: 'boot', passed: true, pid: 100, command: 'dsh', args: ['--profile', 'unit', '--host', '127.0.0.1', '--port', '0', '--no-open'] },
      { id: 'stop-for-restart', passed: true, pid: 100, exitCode: 0, signal: null, at },
      { id: 'boot-2', passed: true, pid: 101, command: 'dsh', args: ['--profile', 'unit', '--host', '127.0.0.1', '--port', '0', '--no-open'], at }
    ],
    rpc: ['blueprint/ping', 'blueprint/inspectSession', 'blueprint/loadDefinition', 'blueprint/ping', 'blueprint/inspectSession', 'session/list'].map(
      (method, i) => ({
        method,
        rpcId: `rpc-${i}`,
        responseRpcId: `rpc-${i}`,
        at,
        hostInstance: i < 3 ? 1 : 2,
        status: 200,
        ok: true,
        provenance: 'real public DSH gateway'
      })
    ),
    observer: {
      provenance: 'public DSH observer',
      sessions:
        mode === 'live'
          ? [
              {
                sessionId: 'child',
                runtimeError: false,
                requests: [{ identity: 'child:1', ordinal: 1, turn: 1, step: 1, failed: false }],
                approvals: [],
                toolCalls: []
              },
              {
                sessionId: 'parent',
                runtimeError: false,
                requests: [],
                approvals: [{ ...pending, outcome: 'allowed-once', pending: false, decidedLogged: true, decidedSeq: 6 }],
                toolCalls: [
                  ...['blueprint_start', 'blueprint_list', 'blueprint_inspect'].map((name, i) => ({
                    name,
                    callId: ['call-unit', 'list-unit', 'inspect-unit'][i],
                    inputSha256: '9'.repeat(64),
                    ok: true,
                    turn: 1,
                    callLogged: true,
                    resultLogged: true,
                    pipelineResultObserved: true,
                    callSeq: 7,
                    resultSeq: 8
                  })),
                  {
                    name: 'write',
                    callId: 'write-unit',
                    callSeq: 4,
                    resultSeq: 9,
                    callLogged: true,
                    resultLogged: true,
                    ok: true,
                    isError: false,
                    pipelineIsError: false,
                    pipelineResultObserved: true
                  }
                ]
              }
            ]
          : []
    },
    browserEvidence: true,
    providerEvidence: mode === 'live',
    notRun: mode === 'live' ? [] : ['real-provider'],
    cases: Object.entries(cases).map(([id, facts]) => ({ id, facts, at, screenshot: image, provenance: 'actual native browser + public gateway' }))
  }
  receipt.restart = {
    invoked: true,
    stopped: true,
    sameProfile: true,
    authenticated: true,
    pluginPing: true,
    firstPid: 100,
    secondPid: 101,
    at,
    finishedAt: at,
    clientBundle: { status: 200, closure: true },
    firstObserverSha256: sha256(JSON.stringify(receipt.observer)),
    observer: { provenance: 'public DSH observer', sessions: [] },
    nativeRequests: []
  }
  return JSON.parse(JSON.stringify(receipt))
}
function setup(fn) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'collector-unit-evidence-'))
  try {
    fn(root, syntheticReceipt(root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
const validate = (receipt, root) =>
  validateCollectorGate(receipt, { reportDir: root, evidenceRoot: dirname(root), fingerprint: receipt.fingerprint, fingerprintAfter: receipt.fingerprintAfter })
function withSecondHostProjections(receipt) {
  const read = receipt.rpc.find(item => item.hostInstance === 2 && item.method === 'session/list')
  for (const target of ['parent', 'child']) {
    const rpcId = `projection-${target}`
    receipt.rpc.push({ ...read, method: 'session/projections', rpcId, responseRpcId: rpcId })
  }
  return receipt
}

test('second-host accepts readonly catalog and descriptor projections in keyless and live controls', () =>
  setup((root, live) => {
    for (const receipt of [live, syntheticReceipt(root, 'keyless')]) {
      assert.equal(validate(withSecondHostProjections(receipt), root).ok, true)
    }
  }))

test('bound collector waits for the requested run and frozen revision before accepting a visible root', () => {
  const inspected = { status: 'bound', sessionId: 'source', selected: { run: { runId: 'run-fresh', definitionRevision: 'revision-fresh' } } }
  assert.equal(conversationDomReadyForSession({ sessionId: 'source', runId: 'run-stale', revision: 'revision-fresh' }, 'source', inspected), false)
  assert.equal(conversationDomReadyForSession({ sessionId: 'source', runId: 'run-fresh', revision: 'revision-fresh' }, 'source', inspected), true)
  assert.equal(conversationDomReadyForSession({ sessionId: 'other', runId: 'run-fresh', revision: 'revision-fresh' }, 'source', inspected), false)
})

test('unbound collector keeps the empty run projection contract', () => {
  const inspected = { status: 'unbound', sessionId: 'plain' }
  assert.equal(conversationDomReadyForSession({ sessionId: 'plain', runId: '', revision: '' }, 'plain', inspected), true)
  assert.equal(conversationDomReadyForSession({ sessionId: 'plain', runId: 'stale-run', revision: '' }, 'plain', inspected), false)
})

test('second-host projection reads cannot mask prompt/start/cancel/retry or model dispatch', () =>
  setup((root, live) => {
    const methods = ['session/prompt', 'blueprint/startRun', 'blueprint/startSessionRun', 'session/cancel', 'blueprint/cancelRun', 'blueprint/retry']
    const mutations = [
      ...methods.map(method => r => {
        const rpcId = 'unexpected-dispatch'
        r.rpc.push({ ...r.rpc.at(-1), method, rpcId, responseRpcId: rpcId })
      }),
      ...methods.map(method => r => r.restart.nativeRequests.push({ method, mutation: true })),
      r => r.restart.observer.sessions.push({ sessionId: 'child', runtimeError: false, requests: [{ identity: 'second-call' }], approvals: [] })
    ]
    for (const baseline of [live, syntheticReceipt(root, 'keyless')]) {
      assert.equal(validate(withSecondHostProjections(baseline), root).ok, true)
      for (const mutate of mutations) {
        const receipt = structuredClone(baseline)
        mutate(receipt)
        assert.throws(() => validate(receipt, root), { code: 'EVIDENCE_HOST_RESTART_SIDE_EFFECT_OR_OBSERVER_CHANGED' })
      }
    }
  }))

test('real host restart is required; page reload and first boot cannot substitute', () =>
  setup((root, receipt) => {
    receipt.cases = receipt.cases.filter(item => item.id !== 'host-restart')
    assert.throws(() => validate(receipt, root), /EVIDENCE_(?:HOST_RESTART|CASES)/)
  }))
test('restart rejects failed invocation, old process, missing second auth/bundle, changed profile and lost first-host evidence', () =>
  setup((root, baseline) => {
    for (const mutate of [
      r => (r.restart.invoked = false),
      r => (r.restart.stopped = false),
      r => (r.restart.authenticated = false),
      r => (r.restart.sameProfile = false),
      r => (r.restart.secondPid = r.restart.firstPid),
      r => (r.restart.clientBundle.status = 404),
      r => (r.steps = r.steps.filter(step => step.id !== 'boot-2')),
      r => (r.steps.find(step => step.id === 'boot-2').passed = false),
      r => (r.steps.find(step => step.id === 'boot-2').args = ['--profile', 'other']),
      r => (r.observer.sessions = []),
      r => {
        for (const step of r.steps.filter(item => ['boot', 'boot-2'].includes(item.id))) {
          delete step.command
          delete step.args
        }
      },
      r => (r.restart.firstObserverSha256 = '0'.repeat(64)),
      r => (r.rpc = r.rpc.filter(item => item.hostInstance !== 2))
    ]) {
      const receipt = structuredClone(baseline)
      mutate(receipt)
      assert.throws(() => validate(receipt, root), /EVIDENCE_/)
    }
  }))
test('restart rejects wrong Session/Attempt/source/frozen graph and implicit prompt or model dispatch', () =>
  setup((root, live) => {
    const facts = r => r.cases.find(item => item.id === 'host-restart').facts
    for (const baseline of [live, syntheticReceipt(root, 'keyless')]) {
      assert.equal(validate(withSecondHostProjections(baseline), root).ok, true)
      for (const mutate of [
        r => (facts(r).after.sessionId = 'other'),
        r => (facts(r).after.focusAttemptIds = ['other-attempt']),
        r => (facts(r).after.revision = 'live-definition'),
        r => (facts(r).sourceAfter.callId = 'wrong-call'),
        r => (facts(r).mutationDelta = 1),
        r => (facts(r).runStateAfter = 'recovery_required'),
        r => {
          facts(r).runStateBefore = 'recovery_required'
          facts(r).runStateAfter = 'recovery_required'
        },
        r => r.restart.nativeRequests.push({ method: 'session/prompt', mutation: true }),
        r => (r.rpc.at(-1).method = 'blueprint/startSessionRun'),
        r => r.restart.observer.sessions.push({ runtimeError: false, requests: [{ identity: 'second-call' }], approvals: [] })
      ]) {
        const receipt = structuredClone(baseline)
        mutate(receipt)
        assert.throws(() => validate(receipt, root), /EVIDENCE_HOST_RESTART/)
      }
    }
  }))
test('live requires observed catalog/inspect calls and exact real child/downstream artifact lineage', () =>
  setup((root, baseline) => {
    const child = r => r.cases.find(item => item.id === 'child-artifact').facts
    for (const mutate of [
      r => (child(r).executionSessionId = 'wrong-child'),
      r => (child(r).downstreamSha256 = '0'.repeat(64)),
      r => {
        for (const id of ['refresh-attempt', 'frozen-graph', 'host-restart']) {
          const facts = r.cases.find(item => item.id === id).facts
          facts.before.sessionId = 'parent'
          facts.after.sessionId = 'parent'
        }
      },
      r => (child(r).acceptanceCode = 'unverified'),
      r => (r.cases.find(item => item.id === 'tool-lineage').facts.catalogCallId = 'made-up-list'),
      r => (r.cases.find(item => item.id === 'tool-lineage').facts.inspectCallId = 'made-up-inspect')
    ]) {
      const receipt = structuredClone(baseline)
      mutate(receipt)
      assert.throws(() => validate(receipt, root), /EVIDENCE_(?:CHILD|NATIVE_TOOL)/)
    }
  }))
test('approval decision alone cannot prove that the native write tool succeeded or wrote the file', () =>
  setup((root, receipt) => {
    delete receipt.cases.find(item => item.id === 'native-approval').facts.effect
    assert.throws(() => validate(receipt, root), /EVIDENCE_NATIVE_APPROVAL/)
  }))
test('approval rejects failed or wrong-call tool results, result before decision, absent/wrong file effect', () =>
  setup((root, baseline) => {
    const approval = r => r.cases.find(item => item.id === 'native-approval').facts
    for (const mutate of [
      r => (approval(r).tool.callId = 'other-call'),
      r => (approval(r).tool.isError = true),
      r => (approval(r).tool.pipelineIsError = true),
      r => (approval(r).tool.resultSeq = approval(r).after.decidedSeq),
      r => (approval(r).effect.sha256 = '0'.repeat(64)),
      r => approval(r).effect.bytes++,
      r => (r.observer.sessions.find(item => item.sessionId === 'parent').toolCalls.find(item => item.name === 'write').pipelineResultObserved = false)
    ]) {
      const receipt = structuredClone(baseline)
      mutate(receipt)
      // The primary observer is signed again only in this synthetic control, to
      // isolate the settlement oracle rather than its independent restart seal.
      receipt.restart.firstObserverSha256 = sha256(JSON.stringify(receipt.observer))
      assert.throws(() => validate(receipt, root), /EVIDENCE_NATIVE_APPROVAL/)
    }
  }))

test('synthetic validator control covers complete keyless and live receipt fields only', () =>
  setup((root, receipt) => {
    assert.equal(validate(receipt, root).providerEvidence, true)
    assert.equal(validate(syntheticReceipt(root, 'keyless'), root).providerEvidence, false)
  }))
test('missing/duplicate/stale scene or screenshot is rejected', () =>
  setup((root, baseline) => {
    for (const mutate of [
      r => r.cases.pop(),
      r => (r.cases[1].id = r.cases[0].id),
      r => (r.cases[0].at = '2020-01-01'),
      r => (r.cases[0].screenshot.sha256 = '0'.repeat(64)),
      r => (r.cases[0].screenshot.provenance = 'synthetic-preview')
    ]) {
      const receipt = structuredClone(baseline)
      mutate(receipt)
      assert.throws(() => validate(receipt, root), /EVIDENCE_/)
    }
  }))
test('fingerprint drift, failed subprocess, missing native boot and wrong RPC correlation fail', () =>
  setup((root, baseline) => {
    for (const mutate of [
      r => (r.fingerprintAfter.source_sha256 = '0'.repeat(64)),
      r => (r.provenanceAfter.helpers[0].sha256 = '0'.repeat(64)),
      r => (r.steps[0].exitCode = 1),
      r => (r.steps[0].exitCode = null),
      r => (r.steps[0].signal = 'SIGTERM'),
      r => (r.browser.closed = false),
      r => (r.browser.defaultContext = false),
      r => (r.boot.clientBundle.status = 404),
      r => (r.rpc[0].responseRpcId = 'other'),
      r => (r.cleanup.hostStopped = false)
    ]) {
      const receipt = structuredClone(baseline)
      mutate(receipt)
      assert.throws(() => validate(receipt, root), /EVIDENCE_/)
    }
  }))
test('9 switches, stopped stream, repeated model call and mutation cannot satisfy 10-switch gate', () =>
  setup((root, baseline) => {
    const stream = r => r.cases.find(item => item.id === 'stream-switch-10').facts
    for (const mutate of [
      r => stream(r).switches.pop(),
      r => (stream(r).switches[0].after.active = false),
      r => stream(r).switches[0].after.totalCalls++,
      r => (stream(r).switches[0].after.requestIdentity = 'other:1'),
      r => stream(r).switches[0].after.identities.push('duplicate:2'),
      r => (stream(r).switches[0].mutationDelta = 1),
      r => (stream(r).switches[0].before.textDeltas = 0)
    ]) {
      const receipt = structuredClone(baseline)
      mutate(receipt)
      assert.throws(() => validate(receipt, root), /EVIDENCE_/)
    }
  }))
test('changed draft/Attempt/native approval key/Host audit call/settlement and plain lineage fail', () =>
  setup((root, baseline) => {
    const facts = (r, id) => r.cases.find(item => item.id === id).facts
    for (const mutate of [
      r => (facts(r, 'native-draft').reloadedSha256 = '0'.repeat(64)),
      r => (facts(r, 'refresh-attempt').after.runId = 'wrong'),
      r => (facts(r, 'frozen-graph').liveDefinitionRevision = 'old'),
      r => (facts(r, 'native-approval').identities[0].nativeKey = 'approval:2'),
      r => (facts(r, 'native-approval').after.callId = 'new-call'),
      r => (facts(r, 'native-approval').after.outcome = 'unavailable'),
      r => (facts(r, 'plain-unbound').dom.runId = 'inferred-run'),
      r => (facts(r, 'tool-lineage').nativeToolResultObserved = false)
    ]) {
      const receipt = structuredClone(baseline)
      mutate(receipt)
      assert.throws(() => validate(receipt, root), /EVIDENCE_/)
    }
  }))
test('keyless claims cannot consume or count a real-provider substitute', () =>
  setup(root => {
    const receipt = syntheticReceipt(root, 'keyless')
    receipt.providerEvidence = true
    assert.throws(() => validate(receipt, root), /EVIDENCE_KEYLESS/)
  }))
test('artifact symlinks and secret diagnostics retain only relative path/category', () =>
  setup((root, receipt) => {
    const path = join(root, 'linked.png')
    symlinkSync(receipt.cases[0].screenshot.path, path)
    assert.throws(
      () => validateScreenshot({ ...receipt.cases[0].screenshot, path }, root, Date.parse(receipt.startedAt), Date.parse(receipt.finishedAt)),
      /PATH_SYMLINK/
    )
    rmSync(path)
    const value = `sk-${'x'.repeat(30)}`
    writeFileSync(join(root, 'unsafe.log'), value)
    assert.deepEqual(auditArtifacts(root), [{ path: 'unsafe.log', category: 'api-key' }])
    assert.ok(!JSON.stringify(auditArtifacts(root)).includes(value))
  }))
