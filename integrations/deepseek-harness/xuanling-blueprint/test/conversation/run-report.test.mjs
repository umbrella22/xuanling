import assert from 'node:assert/strict'
import test from 'node:test'
import { projectRunReport, reportGuidance, REPORT_GUIDANCE } from '../../src/conversation/run-report.ts'
import { runReportCodec } from '../../src/conversation/contracts.ts'

const definition = {
  schemaVersion: 2,
  id: 'code-review',
  name: 'Code review',
  resources: {},
  graph: {
    nodes: [
      { id: 'collect', kind: 'agent' },
      { id: 'review', kind: 'agent' }
    ],
    edges: []
  },
  presentation: { nodes: { collect: { x: 0, y: 0, title: 'Collect diff' }, review: { x: 1, y: 0 } } }
}

const pinnedDefinition = {
  schemaVersion: 2,
  id: 'pinned-route',
  name: 'Pinned route',
  resources: {},
  graph: {
    nodes: [
      { id: 'review', kind: 'agentTask', modelSelection: { provider: 'openai', model: 'gpt-x', reasoningEffort: 'high' } },
      { id: 'collect', kind: 'agentTask' }
    ],
    edges: []
  },
  presentation: { nodes: {} }
}

function record(overrides = {}) {
  return {
    runId: 'run-1',
    state: 'failed',
    definitionRevision: 'rev-1',
    definitionJson: JSON.stringify(definition),
    inputRef: 'input',
    commandKey: 'cmd',
    bindingSelections: { collect: { provider: 'deepseek', model: 'deepseek-chat' }, review: null },
    seq: 6,
    createdAt: 1_000,
    updatedAt: 9_000,
    log: [],
    attempts: [
      {
        attemptId: 'a1',
        nodeId: 'collect',
        state: 'succeeded',
        attempt: 1,
        sessionId: 'child-1',
        intent: { seq: 2, at: 1_000, kind: 'agent', resourceDigests: {} },
        result: { seq: 3, at: 3_500, ok: true, outcome: { kind: 'succeeded', outputs: { secret: 'value' } }, evidence: 'raw transcript text' }
      },
      {
        attemptId: 'a2',
        nodeId: 'review',
        state: 'failed',
        attempt: 1,
        intent: { seq: 4, at: 4_000, kind: 'agent', resourceDigests: {} },
        result: { seq: 5, at: 8_000, ok: false, outcome: { kind: 'structured-output-missing' }, evidence: 'provider said something private' }
      }
    ],
    ...overrides
  }
}

test('run report explains what ran, which step failed, why, and how to avoid it', () => {
  const report = projectRunReport(record())
  assert.equal(report.outcome, 'failed')
  assert.deepEqual(report.workflow, { id: 'code-review', name: 'Code review', definitionRevision: 'rev-1' })
  assert.equal(report.timing.durationMs, 8_000)
  assert.deepEqual(report.summary, { steps: 2, succeeded: 1, failed: 1, skipped: 0, pending: 0 })
  assert.equal(report.steps[0].title, 'Collect diff')
  assert.equal(report.steps[0].durationMs, 2_500)
  assert.equal(report.steps[1].durationMs, 4_000)
  assert.deepEqual(report.steps[0].model, { provider: 'deepseek', model: 'deepseek-chat' })
  assert.equal(Object.hasOwn(report.steps[1], 'model'), false, 'a null Host default route is not invented')
  assert.equal(report.steps[1].errorCode, 'structured-output-missing')
  assert.equal(report.problems.length, 1)
  assert.equal(report.problems[0].nodeId, 'review')
  assert.equal(report.problems[0].why, REPORT_GUIDANCE['structured-output-missing'].why)
  assert.match(report.markdown, /## What went wrong and how to avoid it/)
  assert.match(report.markdown, /Collect diff \(collect\)/)
  assert.equal(runReportCodec().safeParse(report).success, true, 'the strict wire codec accepts the projected report')
})

test('run report never leaks raw evidence, outputs, or child session ids', () => {
  const report = projectRunReport(record())
  const text = JSON.stringify(report)
  assert.doesNotMatch(text, /raw transcript text|provider said something private|"secret"/)
  assert.doesNotMatch(text, /child-1/, 'child step session IDs never cross the report boundary')
  assert.equal(Object.hasOwn(report.steps[0], 'sessionId'), false)
})

test('run report surfaces unresolved recovery and the operator resolution note', () => {
  const pending = projectRunReport(
    record({
      state: 'recovery_required',
      attempts: [
        { attemptId: 'a1', nodeId: 'collect', state: 'recovery_required', attempt: 1, intent: { seq: 2, at: 1_000, kind: 'agent', resourceDigests: {} } }
      ],
      log: [{ seq: 3, at: 2_000, kind: 'recovery', detail: { attemptId: 'a1', nodeId: 'collect', reason: 'intent-without-result' } }]
    })
  )
  assert.equal(pending.outcome, 'needs-recovery')
  assert.deepEqual(
    pending.problems.map(problem => problem.code),
    ['recovery-unresolved', 'intent-without-result']
  )
  assert.deepEqual(pending.recovery, { reason: 'intent-without-result' })

  const resolved = projectRunReport(
    record({
      state: 'failed',
      attempts: [],
      log: [
        { seq: 3, at: 2_000, kind: 'recovery', detail: { reason: 'intent-without-result' } },
        { seq: 4, at: 3_000, kind: 'state', detail: { recovery: 'failed', evidence: 'x'.repeat(900) } }
      ]
    })
  )
  assert.equal(resolved.recovery.resolvedAs, 'failed')
  assert.ok(resolved.recovery.note.length <= 501, 'operator note is bounded')
  assert.match(resolved.markdown, /Resolution: failed/)
})

test('run report replaces unknown outcome codes with the durable attempt state', () => {
  const report = projectRunReport(
    record({
      definitionJson: '{',
      attempts: [
        { attemptId: 'a1', nodeId: 'x', state: 'failed', attempt: 1, result: { seq: 1, at: 1, ok: false, outcome: { kind: 'brand-new-code' }, evidence: '' } }
      ]
    })
  )
  assert.equal(report.workflow.name, undefined)
  assert.equal(report.steps[0].errorCode, 'failed')
  assert.equal(report.steps[0].resultKind, 'failed')
  assert.equal(report.problems[0].code, 'failed')
  assert.equal(report.problems[0].why, reportGuidance('failed').why)
  assert.equal(report.problems[0].avoid, reportGuidance('failed').avoid)
  assert.doesNotMatch(JSON.stringify(report), /brand-new-code/, 'no surface echoes the unknown outcome kind')
})

test('run report falls back to a pinned definition model route', () => {
  const attempt = {
    attemptId: 'a1',
    nodeId: 'review',
    state: 'succeeded',
    attempt: 1,
    intent: { seq: 2, at: 1_000, kind: 'agentTask', resourceDigests: {} },
    result: { seq: 3, at: 2_000, ok: true, outcome: { kind: 'succeeded' }, evidence: '' }
  }
  const pinned = projectRunReport(
    record({
      definitionJson: JSON.stringify(pinnedDefinition),
      // Pinned routes are never persisted in bindingSelections: only inherited
      // Host routes are. The frozen definition keeps the pinned route.
      bindingSelections: { collect: null },
      attempts: [attempt]
    })
  )
  assert.deepEqual(pinned.steps[0].model, { provider: 'openai', model: 'gpt-x', reasoningEffort: 'high' })
  assert.equal(runReportCodec().safeParse(pinned).success, true)

  const bindingDefault = projectRunReport(
    record({
      definitionJson: JSON.stringify(pinnedDefinition),
      bindingSelections: { review: null },
      attempts: [attempt]
    })
  )
  assert.equal(Object.hasOwn(bindingDefault.steps[0], 'model'), false, 'an explicit null binding means Host default, never the pinned route')
})

test('run report omits duration for attempts settled by human recovery', () => {
  const recovered = projectRunReport(
    record({
      state: 'failed',
      attempts: [
        {
          attemptId: 'a1',
          nodeId: 'collect',
          state: 'failed',
          attempt: 1,
          intent: { seq: 2, at: 1_000, kind: 'agent', resourceDigests: {} },
          result: { seq: 3, at: 600_000, ok: false, outcome: { recovery: 'failed', kind: 'failed' }, evidence: 'operator reviewed the session' }
        }
      ]
    })
  )
  assert.equal(Object.hasOwn(recovered.steps[0], 'durationMs'), false, 'operator resolution time is not a step duration')
  assert.equal(recovered.steps[0].errorCode, 'failed')
  assert.doesNotMatch(recovered.markdown, /599\.0s/)
  assert.equal(runReportCodec().safeParse(recovered).success, true)

  const emptyMarker = projectRunReport(
    record({
      state: 'failed',
      attempts: [
        {
          attemptId: 'a1',
          nodeId: 'collect',
          state: 'failed',
          attempt: 1,
          intent: { seq: 2, at: 1_000, kind: 'agent', resourceDigests: {} },
          result: { seq: 3, at: 600_000, ok: false, outcome: { recovery: '', kind: 'failed' }, evidence: 'empty marker is not a resolution' }
        }
      ]
    })
  )
  assert.equal(emptyMarker.steps[0].durationMs, 599_000, 'only a non-empty recovery marker suppresses the duration')
})
