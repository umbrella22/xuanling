/**
 * W1.1 / Sol B — source red oracles for C-05/C-06/C-07/C-08/C-10.
 * W2 MUST NOT run this entry; W3 must run it without skip/ignored assertions.
 *
 * Surfaces are deliberately separated:
 *  - configured service loadDefinition/startRun -> actual supervised driveRun;
 *  - strict definition/Typert codecs, including explicit missing-capability reds;
 *  - seeded real RunStore -> actual driveRun, to isolate execution from the
 *    absent additive condition codec. This is NOT full service admission green.
 *  - production workspace/remote/model/editor/Inspector and locale render data.
 * No executor replacement, scheduler-only green, build/lib, provider request,
 * browser acceptance, fake React hooks, sleep, or another worker's helpers.
 * Public DTO means BLUEPRINT_INVOCATIONS' strict inspectRun result codec; there
 * is no imported invented publicDTO module. Actual browser QA belongs to W3.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Context } from '@deepseek-ai/cordis'
import { BlueprintService } from '../../src/index.ts'
import { decodeDefinition, validateDefinition } from '../../src/definition/index.ts'
import { computeRevision } from '../../src/definition/revision.ts'
import { BLUEPRINT_INVOCATIONS } from '../../src/typert-descriptors.ts'
import { BlueprintWorkspace } from '../../src/client/features/authoring/logic/workspace/workspace-controller.ts'
import { BlueprintClientModel } from '../../src/client/features/authoring/logic/run/client-model.ts'
import { resolveBlueprintHost } from '../../src/client/adapters/host/remote.ts'
import { GraphEditor, editorNodeDisplayTitle } from '../../src/client/features/authoring/logic/graph/graph-editor.ts'
import { BUILTIN_NODE_CATALOG, searchBuiltinNodes } from '../../src/client/features/authoring/logic/graph/node-catalog.ts'
import {
  parseInspectorJson,
  applyInspectorPatch,
  InspectorSession,
  renderNodeInspector
} from '../../src/client/features/authoring/ui/inspector/inspector-composition.tsx'
import { en, zh } from '../../src/client/shared/i18n/locales.ts'
import { flowAriaLabels, runStateTitle } from '../../src/client/features/authoring/presenters/canvas-presentation.ts'

const sha = value => createHash('sha256').update(value).digest('hex')
const json = JSON.stringify
const baseDefinition = (nodes, edges = [], resources = {}, id = 'flow-contracts') => ({
  schemaVersion: 1,
  id,
  name: '用户标题 / flow contracts',
  resources,
  graph: { nodes, edges }
})
function oldReadable(value) {
  validateDefinition(decodeDefinition(json(value)))
  return value
}
const branchConfig = { inputPort: 'predicate', trueBranch: 'yes', falseBranch: 'no' }
const legacyCondition = () =>
  oldReadable(
    baseDefinition(
      [
        { id: 'choose', kind: 'condition', inputs: { predicate: 'boolean' }, branches: ['yes', 'no'] },
        { id: 'yesPath', kind: 'output' },
        { id: 'noPath', kind: 'output' }
      ],
      [
        { kind: 'control', from: 'choose@yes', to: 'yesPath' },
        { kind: 'control', from: 'choose@no', to: 'noPath' }
      ]
    )
  )
function configuredCondition() {
  const value = legacyCondition()
  value.graph.nodes[0].condition = { ...branchConfig }
  return value
}
const joinGraph = (strategy = 'all', control = false) =>
  oldReadable(
    baseDefinition(
      [
        { id: 'left', kind: 'input', outputs: { value: 'string' } },
        { id: 'right', kind: 'input', outputs: { value: 'string' } },
        { id: 'merge', kind: 'join', join: strategy, inputs: { left: 'string', right: 'string' }, outputs: { left: 'string', right: 'string' } }
      ],
      [
        { kind: 'data', from: 'left.value', to: 'merge.left' },
        { kind: 'data', from: 'right.value', to: 'merge.right' },
        ...(control
          ? [
              { kind: 'control', from: 'left', to: 'merge' },
              { kind: 'control', from: 'right', to: 'merge' }
            ]
          : [])
      ]
    )
  )
const terminal = run => ['succeeded', 'failed', 'cancelled', 'timed_out', 'waiting_input', 'recovery_required'].includes(run.state)

async function serviceFixture(t, definition = oldReadable(baseDefinition([{ id: 'source', kind: 'input', outputs: { value: 'string' } }]))) {
  const root = mkdtempSync(join(tmpdir(), 'bp-flow-contracts-'))
  const packageRoot = join(root, 'package'),
    runtimeRoot = join(root, 'runtime')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  writeFileSync(join(packageRoot, 'blueprint.json'), json(definition))
  const ctx = new Context()
  // No Agent double is required: these graphs use structural nodes only. If a
  // production bug dispatches an Agent, the explicit no-business-call oracle fails.
  const agentCalls = []
  ctx.provide('agents', {
    async create() {
      agentCalls.push('create')
      throw new Error('fixture: unexpected Agent dispatch')
    }
  })
  const fiber = await ctx.plugin(BlueprintService, { blueprints: { [definition.id]: packageRoot }, runtimeRoot })
  const service = ctx.blueprint
  const handle = await service.runtimeFor(runtimeRoot)
  let closed = false
  async function close() {
    if (!closed) {
      closed = true
      await fiber.dispose()
    }
  }
  t.after(async () => {
    await close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, packageRoot, runtimeRoot, ctx, service, handle, agentCalls, close }
}
async function serviceStart(h, input = { value: 'BOUND_VALUE' }, requestId = randomUUID()) {
  const doc = await h.service.loadDefinition({ blueprintId: 'flow-contracts' })
  const args = { blueprintId: doc.blueprintId, expectedRevision: doc.documentRevision, inputJson: json(input), requestId }
  const admission = await h.service.startRun(args)
  await h.handle.driverTail // real supervised job, not an RPC acknowledgement
  const record = await h.handle.store.get(admission.runId)
  assert.ok(terminal(record), 'FIXTURE: actual driver must drain to a known durable state')
  assert.deepEqual(h.agentCalls, [], 'CONTROL: structural flow never dispatches an Agent')
  return { args, admission, record, doc }
}
async function seedRun(h, definition, input = {}) {
  const created = await h.handle.store.createRun(
    { scope: 'run', requestId: randomUUID(), payloadFingerprint: sha(json(definition) + '\0' + json(input)) },
    'seed-semantic',
    json(definition),
    json(input)
  )
  return created.runId
}
async function seedParents(h, runId, states) {
  for (const [nodeId, state, outputs] of states) {
    if (state === 'skipped') {
      await h.handle.store.transition(runId, draft => {
        draft.attempts.push({ attemptId: `skipped-${nodeId}`, nodeId, attempt: 1, state: 'skipped' })
      })
    } else {
      const intent = await h.handle.store.recordIntent(runId, { nodeId, kind: 'input' })
      await h.handle.store.recordResult(runId, intent.attemptId, {
        ok: state === 'succeeded',
        outcome: state === 'succeeded' ? { outputs } : { kind: 'failed' },
        evidence: 'fixture-parent-result'
      })
    }
  }
}
async function seededDriver(h, definition, input, parents = []) {
  const runId = await seedRun(h, definition, input)
  await seedParents(h, runId, parents)
  // Source seam only. Same production driver and real durable store as startRun;
  // we do not pretend that supplying the future field proves codec/admission.
  await h.service.driveRun(h.handle, runId, definition)
  assert.deepEqual(h.agentCalls, [])
  return await h.handle.store.get(runId)
}
function assertBlocked(error, message) {
  assert.equal(error?.code, 'blueprint/preflight-blocked', message)
}

// ---- C-05: shape/semantic capability + real driver behavior, kept separate. ----
test('C-05/C-08 strict codec: valid optional condition survives without changing schemaVersion', () => {
  const value = configuredCondition()
  let decoded, error
  try {
    decoded = decodeDefinition(json(value))
  } catch (caught) {
    error = caught
  }
  if (error) {
    assert.equal(error.code, 'DEFINITION_INVALID', 'FIXTURE: only the known missing additive field is a capability red')
    assert.deepEqual(
      error.issues.map(i => [i.code, i.pointer]),
      [['unknown-field', '/graph/nodes/0/condition']]
    )
  }
  assert.equal(error, undefined, 'C-05 CONDITION_CODEC_UNAVAILABLE: known optional condition is rejected as unknown-field')
  validateDefinition(decoded)
  assert.deepEqual(decoded.graph.nodes[0].condition, branchConfig)
  assert.equal(decoded.schemaVersion, 1)
  const extra = structuredClone(value)
  extra.graph.nodes[0].condition.expression = 'eval must never execute'
  assert.throws(
    () => decodeDefinition(json(extra)),
    error => error.code === 'DEFINITION_INVALID' && error.issues.some(i => i.code === 'unknown-field' && i.pointer === '/graph/nodes/0/condition/expression')
  )
})
for (const [label, change] of [
  [
    'distinct branches',
    node => {
      node.condition.falseBranch = 'yes'
    }
  ],
  [
    'declared branches',
    node => {
      node.condition.trueBranch = 'undeclared'
    }
  ],
  [
    'declared boolean input',
    node => {
      node.inputs.predicate = 'string'
    }
  ],
  [
    'declared inputPort',
    node => {
      node.condition.inputPort = 'absent'
    }
  ],
  [
    'condition-only field',
    node => {
      node.kind = 'input'
    }
  ]
]) {
  test(`C-05 semantic validator: ${label}`, () => {
    const value = configuredCondition()
    change(value.graph.nodes[0])
    // Validator seam: the old reader's shape/refs are controlled separately;
    // these failures specifically prove missing new-field semantic checks.
    if (value.graph.nodes[0].kind !== 'condition') value.graph.edges = []
    assert.throws(
      () => validateDefinition(value),
      error => error.code === 'DEFINITION_INVALID' && error.issues.some(i => /condition|inputs|branches/.test(i.pointer ?? '')),
      `C-05 CONDITION_SEMANTIC_UNCHECKED: ${label} must fail with located typed issue`
    )
  })
}
test('C-08 legacy condition remains readable; new configured service Run must block absent behavior', async t => {
  const definition = legacyCondition()
  const h = await serviceFixture(t, definition)
  const doc = await h.service.loadDefinition({ blueprintId: definition.id })
  assert.deepEqual(decodeDefinition(doc.definitionJson), definition, 'CONTROL: legacy record reads; missing optional condition is not a codec error')
  let error
  try {
    await serviceStart(h, { predicate: true })
  } catch (caught) {
    error = caught
  }
  assertBlocked(error, 'C-08 LEGACY_CONDITION_ADMITTED: absent behavior must block a NEW Run, not wait for human input')
  assert.deepEqual(await h.handle.store.listRunIds(), [])
})
for (const predicate of [true, false]) {
  test(`C-05 real seeded driver: boolean ${predicate} auto-selects a durable branch, never waiting_input`, async t => {
    const h = await serviceFixture(t)
    const value = configuredCondition()
    const record = await seededDriver(h, value, { predicate })
    assert.equal(record.state, 'succeeded', 'C-05 CONDITION_STILL_WAITING_INPUT: boolean condition must automatically settle, not request approval')
    const attempt = record.attempts.find(a => a.nodeId === 'choose')
    assert.equal(attempt.result.outcome.branch, predicate ? 'yes' : 'no')
    assert.equal(record.attempts.find(a => a.nodeId === (predicate ? 'yesPath' : 'noPath')).state, 'succeeded')
    assert.equal(record.attempts.find(a => a.nodeId === (predicate ? 'noPath' : 'yesPath')).state, 'skipped')
    const before = structuredClone(record)
    await h.service.driveRun(h.handle, record.runId, value)
    assert.deepEqual(await h.handle.store.get(record.runId), before, 'C-08: terminal drive is idempotent')
  })
}
for (const predicate of ['true', 1, null]) {
  test(`C-05 real seeded driver: ${json(predicate)} is not a boolean and cannot reach downstream`, async t => {
    const h = await serviceFixture(t)
    const record = await seededDriver(h, configuredCondition(), { predicate })
    assert.equal(record.state, 'failed', 'C-05 CONDITION_INVALID_WAITING: invalid boolean must fail, never coerce or wait for human approval')
    assert.equal(record.attempts.find(a => a.nodeId === 'choose').result.outcome.kind, 'condition-input-invalid')
    assert.ok(record.attempts.every(a => a.nodeId === 'choose' || a.state === 'skipped'))
  })
}
test('C-05/C-08 preservation: humanDecision still waits for a durable human decision', async t => {
  const definition = oldReadable(baseDefinition([{ id: 'approve', kind: 'humanDecision', branches: ['approve', 'reject'] }]))
  const h = await serviceFixture(t, definition)
  const { admission, record } = await serviceStart(h)
  assert.equal(record.state, 'waiting_input')
  assert.equal(record.attempts[0].state, 'waiting_input')
  assert.equal(record.attempts[0].result, undefined)
  const after = await h.service.decide({ runId: admission.runId, decisionId: 'explicit-approval', action: 'approve' })
  await h.handle.driverTail
  assert.equal(after.applied, true)
  assert.equal((await h.handle.store.get(admission.runId)).attempts[0].result.outcome.branch, 'approve')
})

// ---- C-06: admission and seeded driver, not just readyNodes() assertions. ----
test('C-06 configured service: join-all executes and preserves declared typed outputs', async t => {
  const h = await serviceFixture(t, joinGraph())
  const { record } = await serviceStart(h)
  assert.equal(record.state, 'succeeded', 'C-06 JOIN_EXECUTOR_UNAVAILABLE: selected-all join is still unsupported in the actual driver')
  assert.deepEqual(record.attempts.find(a => a.nodeId === 'merge').result.outcome.outputs, { left: 'BOUND_VALUE', right: 'BOUND_VALUE' })
})
test('C-06 default join=all is readable and executable, not a required legacy strategy fixture error', () => {
  const value = joinGraph()
  delete value.graph.nodes[2].join
  const decoded = decodeDefinition(json(value))
  assert.doesNotThrow(() => validateDefinition(decoded), 'C-06 DEFAULT_ALL_REJECTED: omitted join strategy must mean all')
})
for (const control of [false, true]) {
  test(`C-06 real driver: selected-only binding ignores skipped missing output (${control ? 'control and data parents' : 'data parents'})`, async t => {
    const value = joinGraph('all', control),
      h = await serviceFixture(t, value)
    const record = await seededDriver(h, value, {}, [
      ['left', 'succeeded', { value: 'SELECTED' }],
      ['right', 'skipped']
    ])
    const merge = record.attempts.find(a => a.nodeId === 'merge')
    assert.equal(merge?.state, 'succeeded', 'C-06 SELECTED_JOIN_FAILED: skipped parent must not suppress join or require its absent outputs')
    assert.deepEqual(merge.result.outcome.outputs, { left: 'SELECTED' })
    assert.equal(record.state, 'succeeded')
    assert.equal(record.attempts.find(a => a.nodeId === 'right').result, undefined, 'CONTROL: skipped parent truly has no output result')
    const before = structuredClone(record)
    await h.service.driveRun(h.handle, record.runId, value)
    assert.deepEqual(await h.handle.store.get(record.runId), before)
  })
}
test('C-06 preservation: no selected parents makes join skipped, not an empty successful dispatch', async t => {
  const value = joinGraph(),
    h = await serviceFixture(t, value)
  const record = await seededDriver(h, value, {}, [
    ['left', 'skipped'],
    ['right', 'skipped']
  ])
  const merge = record.attempts.find(a => a.nodeId === 'merge')
  assert.equal(merge.state, 'skipped')
  assert.equal(merge.intent, undefined)
  assert.equal(merge.result, undefined)
  assert.equal(record.state, 'succeeded')
})
test('C-06 preservation: selected failure never produces a successful join or partial_success', async t => {
  const value = joinGraph(),
    h = await serviceFixture(t, value)
  const record = await seededDriver(h, value, {}, [
    ['left', 'failed'],
    ['right', 'skipped']
  ])
  assert.equal(record.state, 'failed')
  assert.equal(
    record.attempts.some(a => a.nodeId === 'merge' && a.state === 'succeeded'),
    false
  )
})
test('C-06 real driver: missing selected output has typed failure, not generic failed', async t => {
  const value = joinGraph(),
    h = await serviceFixture(t, value)
  const record = await seededDriver(h, value, {}, [
    ['left', 'succeeded', {}],
    ['right', 'skipped']
  ])
  assert.equal(record.state, 'failed', 'CONTROL: missing selected input cannot succeed')
  const view = await h.service.inspectRun({ runId: record.runId })
  assert.match(
    view.attempts.find(a => a.nodeId === 'merge').errorCode,
    /(?:input|binding|output)-(?:invalid|unavailable|missing)/,
    'C-06 JOIN_FAILURE_UNTYPED: durable generic failed does not identify invalid selected input'
  )
})

// ---- C-10: readable vocabulary is NOT permission to start a new Run. ----
const deferredNodes = [
  ['toolCall', { id: 'future', kind: 'toolCall' }],
  ['scriptCall', { id: 'future', kind: 'scriptCall' }],
  ['iteration', { id: 'future', kind: 'iteration', budget: { maxIterations: 1, maxDurationMs: 1000 } }],
  ['join-any', { id: 'future', kind: 'join', join: 'any' }],
  ['subflow', { id: 'future', kind: 'subflow', subflowRef: 'child' }]
]
for (const [label, node] of deferredNodes) {
  test(`C-08/C-10 ${label}: old vocabulary reads but configured service prevents a new Run`, async t => {
    const resources = label === 'subflow' ? { child: { kind: 'subflow', path: 'lib/child.json' } } : {}
    const value = oldReadable(baseDefinition([node], [], resources))
    const h = await serviceFixture(t, value)
    if (label === 'subflow') writeFileSync(join(h.packageRoot, 'lib', 'child.json'), json(baseDefinition([{ id: 'inside', kind: 'input' }], [], {}, 'child')))
    const doc = await h.service.loadDefinition({ blueprintId: value.id })
    assert.equal(decodeDefinition(doc.definitionJson).graph.nodes[0].kind, node.kind)
    let error
    try {
      await serviceStart(h)
    } catch (caught) {
      error = caught
    }
    assertBlocked(error, `C-10 UNSUPPORTED_NODE_ADMITTED: ${label} must report node-executor-unavailable BEFORE Run creation`)
    assert.deepEqual(await h.handle.store.listRunIds(), [])
    assert.deepEqual(h.agentCalls, [])
  })
}
test('C-10 preservation: TeamStage and future execution kinds are not palette/executable declarations', () => {
  for (const kind of ['TeamStage', 'teamStage', 'toolCall', 'scriptCall', 'subflow', 'iteration']) {
    assert.equal(
      BUILTIN_NODE_CATALOG.some(item => item.kind === kind),
      false
    )
  }
  assert.throws(
    () => decodeDefinition(json(baseDefinition([{ id: 'team', kind: 'teamStage' }]))),
    error => error.code === 'DEFINITION_INVALID' && error.issues.some(i => i.pointer === '/graph/nodes/0/kind')
  )
})
test('C-08 preservation: configured service replay and reopen keep frozen definition and original Run ID', async t => {
  const h = await serviceFixture(t)
  const { args, admission, record } = await serviceStart(h)
  const replay = await h.service.startRun(args)
  await h.handle.driverTail
  assert.equal(replay.replayed, true)
  assert.equal(replay.runId, admission.runId)
  assert.deepEqual(await h.handle.store.get(admission.runId), record)
  await h.close()
  const ctx = new Context()
  const fiber = await ctx.plugin(BlueprintService, { runtimeRoot: h.runtimeRoot })
  try {
    const view = await ctx.blueprint.inspectRun({ runId: admission.runId })
    assert.equal(view.state, 'succeeded')
    assert.equal(view.definitionRevision, record.definitionRevision)
    assert.equal(view.seq, record.seq)
    assert.equal(view.attempts.length, 1)
  } finally {
    await fiber.dispose()
  }
})

// ---- C-07: adapter and existing workspace Run operation. ----
const workspaceDefinition = id => oldReadable(baseDefinition([{ id: 'source', kind: 'input', outputs: { '用户.port': 'string' } }], [], {}, id))
function browserHost(options = {}) {
  const calls = [],
    definitions = new Map(['flow-ui', 'other-ui'].map(id => [id, workspaceDefinition(id)]))
  let revision = 1
  const document = id => ({
    blueprintId: id,
    definitionJson: json(definitions.get(id)),
    documentRevision: `doc-${revision}`,
    semanticRevision: `sem-${sha(json(definitions.get(id).graph))}`,
    layoutRevision: `layout-${revision}`
  })
  const host = {
    async listDefinitions() {
      return {
        definitions: [...definitions.keys()].map(id => ({
          blueprintId: id,
          name: id,
          documentRevision: document(id).documentRevision,
          semanticRevision: document(id).semanticRevision
        }))
      }
    },
    async loadDefinition(id) {
      return document(id)
    },
    async saveDefinition(id, definitionJson, expectedRevision) {
      calls.push(['save', { blueprintId: id, definitionJson, expectedRevision }])
      definitions.set(id, JSON.parse(definitionJson))
      revision++
      return document(id)
    },
    async validate() {
      return { ok: true, semanticRevision: 'draft' }
    },
    async preflightRun(blueprintId, expectedRevision, inputJson) {
      calls.push(['preflight', { blueprintId, expectedRevision, inputJson }])
      const doc = document(blueprintId)
      const report = {
        blueprintId,
        documentRevision: doc.documentRevision,
        semanticRevision: doc.semanticRevision,
        canStart: options.canStart ?? true,
        checks: [
          {
            code: options.canStart === false ? 'node-executor-unavailable' : 'fixture-ready',
            status: options.canStart === false ? 'block' : 'pass',
            nodeId: 'source'
          }
        ]
      }
      options.onCheck?.()
      return options.checkPromise ? await options.checkPromise : report
    },
    async startRun(blueprintId, expectedRevision, inputJson, requestId) {
      calls.push(['start', { blueprintId, expectedRevision, inputJson, requestId }])
      if (options.hostBlock) throw Object.assign(new Error('blueprint/preflight-blocked'), { code: 'blueprint/preflight-blocked' })
      return { runId: 'ui-run', semanticRevision: document(blueprintId).semanticRevision, state: 'queued', replayed: false }
    },
    async inspectRun(runId) {
      calls.push(['inspect', { runId }])
      return { runId, state: 'succeeded', definitionRevision: document('flow-ui').semanticRevision, seq: 2, attempts: [], logTail: [] }
    },
    async cancelRun() {
      assert.fail('unexpected cancel')
    },
    async decide() {
      assert.fail('unexpected decide')
    }
  }
  const storageMap = new Map(),
    storage = { getItem: key => storageMap.get(key) ?? null, setItem: (key, value) => storageMap.set(key, value) }
  return { host, calls, document, storage }
}
async function workspaceFixture(options = {}) {
  const f = browserHost(options),
    workspace = new BlueprintWorkspace(f.host, f.storage)
  await workspace.initialize()
  await workspace.load('flow-ui')
  return { ...f, workspace }
}
test('C-07 remote preflight capability: exact saved revision/input wire and strict report severity', async () => {
  const descriptor = BLUEPRINT_INVOCATIONS.find(i => i.method === 'preflightRun')
  assert.ok(descriptor, 'C-07 PREFLIGHT_DTO_UNAVAILABLE: strict public preflight invocation is absent')
  const args = { blueprintId: 'flow-ui', expectedRevision: 'doc-7', inputJson: '{"用户.port":"原样"}' }
  assert.deepEqual(descriptor.parameters[0].codec.create().parse(args), args)
  let seen
  const report = {
    blueprintId: 'flow-ui',
    documentRevision: 'doc-7',
    semanticRevision: 'sem-7',
    canStart: false,
    checks: [{ code: 'node-executor-unavailable', status: 'block', nodeId: 'future' }]
  }
  const namespace = {
    async preflightRun(value) {
      assert.equal(this, namespace)
      seen = value
      return { ok: true, value: descriptor.result.create().parse(report) }
    }
  }
  const host = resolveBlueprintHost({ get: key => (key === 'remote.blueprint' ? namespace : undefined) })
  assert.equal(typeof host.preflightRun, 'function', 'C-07 PREFLIGHT_ADAPTER_UNAVAILABLE: browser HostLink lacks check operation')
  assert.deepEqual(await host.preflightRun(args.blueprintId, args.expectedRevision, args.inputJson), report)
  assert.deepEqual(seen, args)
  for (const status of ['block', 'warning', 'info', 'pass'])
    assert.equal(descriptor.result.create().safeParse({ ...report, checks: [{ code: 'static-code', status }] }).success, true)
  assert.equal(descriptor.result.create().safeParse({ ...report, raw: 'RAW_SECRET' }).success, false)
})
test('C-07 Run does not silently bypass preflight; check binds the saved revision and captured input', async () => {
  const { workspace, calls } = await workspaceFixture({ canStart: false })
  workspace.inputJson = '{"用户.port":"NOT_TRANSLATED"}'
  let error
  try {
    await workspace.run()
  } catch (caught) {
    error = caught
  }
  const check = calls.find(([method]) => method === 'preflight')
  assert.ok(check, 'C-07 UI_RUN_SKIPS_CHECK: existing workspace Run invokes startRun without preflight')
  assert.deepEqual(check[1], {
    blueprintId: workspace.document.blueprintId,
    expectedRevision: workspace.document.documentRevision,
    inputJson: workspace.inputJson
  })
  assert.equal(
    calls.some(([method]) => method === 'start'),
    false,
    'C-07 block report cannot authorize startup'
  )
  assertBlocked(error, 'C-07 blocked report must remain a typed error')
})
test('C-07 accepted UI check is observation, never permission to bypass Host recheck', async () => {
  const { workspace, calls } = await workspaceFixture({ hostBlock: true })
  let error
  try {
    await workspace.run()
  } catch (caught) {
    error = caught
  }
  assert.ok(
    calls.some(([method]) => method === 'preflight'),
    'C-07 UI_REPORT_MISSING: Run must obtain a report before Host admission'
  )
  assert.equal(calls.filter(([method]) => method === 'start').length, 1)
  assertBlocked(error, 'C-07 host refusal survives an earlier pass report')
  assert.equal(workspace.runId, null)
})
for (const change of ['semantic edit', 'input edit', 'document generation']) {
  test(`C-07 stale check cannot start Run after ${change}`, async () => {
    const check = Promise.withResolvers(),
      seen = Promise.withResolvers()
    const { workspace, calls, document } = await workspaceFixture({ checkPromise: check.promise, onCheck: () => seen.resolve() })
    const before = document('flow-ui'),
      input = workspace.inputJson
    const started = workspace.run().then(
      () => ({ ok: true }),
      error => ({ error })
    )
    // Race against the operation itself instead of a timer. Missing check is an
    // explicit capability assertion, not a hang/sleep/fixture timeout.
    const winner = await Promise.race([seen.promise.then(() => 'checked'), started.then(() => 'finished-without-check')])
    if (winner !== 'checked') {
      check.resolve({
        blueprintId: before.blueprintId,
        documentRevision: before.documentRevision,
        semanticRevision: before.semanticRevision,
        canStart: true,
        checks: []
      })
      assert.equal(winner, 'checked', `C-07 PREFLIGHT_NOT_OBSERVED: cannot bind ${change} when Run never checks`)
    }
    if (change === 'semantic edit') workspace.editor.updateNode('source', { outputs: { '用户.port': 'number' } })
    if (change === 'input edit') workspace.inputJson = '{"changed":true}'
    if (change === 'document generation') await workspace.load('other-ui')
    const saved = calls.find(([method]) => method === 'preflight')[1]
    check.resolve({
      blueprintId: saved.blueprintId,
      documentRevision: saved.expectedRevision,
      semanticRevision: workspace.document?.semanticRevision ?? before.semanticRevision,
      canStart: true,
      checks: []
    })
    await started
    assert.equal(calls.filter(([method]) => method === 'start').length, 0, `C-07 STALE_REPORT_STARTS: ${change} must invalidate the captured report`)
    assert.equal(saved.inputJson, input)
  })
}
test('C-07 old Host: check is explicitly capability-unavailable, never silently skipped', async () => {
  let starts = 0
  const f = browserHost()
  const namespace = {
    listDefinitions: async () => ({ ok: true, value: await f.host.listDefinitions() }),
    loadDefinition: async args => ({ ok: true, value: await f.host.loadDefinition(args.blueprintId) }),
    saveDefinition: async args => ({ ok: true, value: await f.host.saveDefinition(args.blueprintId, args.definitionJson, args.expectedRevision) }),
    startRun: async args => {
      starts++
      return { ok: true, value: await f.host.startRun(args.blueprintId, args.expectedRevision, args.inputJson, args.requestId) }
    },
    inspectRun: async args => ({ ok: true, value: await f.host.inspectRun(args.runId) })
  }
  const host = resolveBlueprintHost({ get: key => (key === 'remote.blueprint' ? namespace : undefined) })
  const workspace = new BlueprintWorkspace(host)
  await workspace.initialize()
  await workspace.load('flow-ui')
  let error
  try {
    await workspace.run()
  } catch (caught) {
    error = caught
  }
  assert.equal(error?.code, 'blueprint/capability-unavailable', 'C-07 OLD_HOST_CHECK_SILENT: old Host lacks preflight and Run must fail closed')
  assert.equal(starts, 0)
})
test('C-07 palette advertises condition and join-all, never deferred executors', () => {
  assert.ok(
    BUILTIN_NODE_CATALOG.some(item => item.kind === 'condition'),
    'C-07 CONDITION_PALETTE_MISSING'
  )
  assert.ok(
    BUILTIN_NODE_CATALOG.some(item => item.kind === 'join'),
    'C-07 JOIN_ALL_PALETTE_MISSING'
  )
  for (const term of ['condition', '条件', 'join', '汇合']) assert.ok(searchBuiltinNodes(term).length > 0)
  assert.equal(
    BUILTIN_NODE_CATALOG.some(item => item.kind === 'join-any'),
    false
  )
})
test('C-07 Inspector expresses optional condition while preserving user IDs/branches/ports', () => {
  const definition = legacyCondition(),
    editor = GraphEditor.fromDefinition(definition)
  const node = editor.nodes.find(n => n.id === 'choose')
  const parsed = parseInspectorJson(node, 'options', json({ condition: branchConfig }))
  assert.equal(parsed.ok, true, 'C-07 CONDITION_INSPECTOR_REJECTS_FIELD: options cannot express boolean behavior')
  assert.equal(applyInspectorPatch(editor, node.id, parsed.patch).ok, true)
  assert.deepEqual(editor.exportDefinition().graph.nodes[0].condition, branchConfig)
  assert.equal(editor.exportDefinition().graph.nodes[0].id, 'choose')
  assert.equal(editor.undo(), true)
  assert.equal(editor.exportDefinition().graph.nodes[0].condition, undefined)
  assert.equal(editor.redo(), true)
  assert.deepEqual(editor.exportDefinition().graph.nodes[0].condition, branchConfig)
})
test('C-07 preservation: Inspector can express join-all without advertising join-any execution', () => {
  const editor = GraphEditor.fromDefinition(joinGraph()),
    node = editor.nodes.find(n => n.id === 'merge')
  assert.deepEqual(parseInspectorJson(node, 'options', '{"join":"all"}'), { ok: true, patch: { join: 'all' } })
  // Historical join-any remains editable/readable, but its NEW service Run is
  // independently required to block above. This is not an execution assertion.
  assert.deepEqual(parseInspectorJson(node, 'options', '{"join":"any"}'), { ok: true, patch: { join: 'any' } })
})

// ---- C-07/C-08 diagnostics and locale: data/source capabilities, not browser QA. ----
test('C-07 public DTO capability: optional diagnostics exists and rejects raw fields', () => {
  const codec = BLUEPRINT_INVOCATIONS.find(i => i.method === 'inspectRun').result.create()
  const attemptCodec = codec.shape.attempts.element
  assert.ok(Object.hasOwn(attemptCodec.shape, 'diagnostics'), 'C-07 DIAGNOSTICS_DTO_UNAVAILABLE: inspectRun cannot carry durable Attempt diagnostics')
  const field = attemptCodec.shape.diagnostics
  assert.equal(field.safeParse(undefined).success, true, 'C-08: old records need no invented diagnostics')
  assert.equal(field.parse(undefined), undefined, 'C-08: legacy absence must remain absent')
  const legacy = {
    runId: 'legacy-run',
    state: 'recovery_required',
    seq: 3,
    definitionRevision: 'sem-old',
    attempts: [{ nodeId: 'old', attempt: 1, state: 'recovery_required' }],
    logTail: []
  }
  assert.deepEqual(codec.parse(legacy), legacy, 'C-08: public DTO must not invent diagnostics')
  const envelope = diagnostics => ({ ...legacy, attempts: [{ ...legacy.attempts[0], diagnostics }] })
  const digest = '0'.repeat(64)
  const available = {
    status: 'available',
    input: { type: 'object', bytes: 2, sha256: digest },
    resourceDigests: {},
    tools: { effectiveNames: [] },
    acceptance: { code: 'not-required' }
  }
  const complete = {
    ...available,
    // These are dynamic resource IDs, not raw fields of a diagnostic object.
    resourceDigests: { '用户.resource/任意-id': digest, rawPrompt: digest },
    modelSelection: { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'adapter-owned-effort' },
    tools: { effectiveNames: ['fixture-tool'], denials: [{ toolName: 'fixture-tool', code: 'denied' }] },
    acceptance: { code: 'passed', issueCount: 0 },
    recovery: { code: 'recovery-required' }
  }
  const variants = [{ status: 'unavailable' }, available, complete]
  for (const value of variants) {
    assert.deepEqual(field.parse(value), value, `C-07: valid ${value.status} diagnostics preserved`)
    assert.deepEqual(codec.parse(envelope(value)), envelope(value), 'C-07: public DTO preserves accepted diagnostics')
  }
  const reject = (value, label, rawKey) => {
    const parsed = field.safeParse(value)
    assert.equal(parsed.success, false, `C-07: ${label} must be rejected`)
    assert.equal(codec.safeParse(envelope(value)).success, false, `C-07: public DTO rejects ${label}`)
    if (rawKey !== undefined)
      assert.ok(
        parsed.error.issues.some(issue => issue.code === 'unrecognized_keys' && issue.keys.includes(rawKey)),
        `C-07: ${label} fails for the unknown raw field`
      )
  }
  // The codec is a strict object union. Parsing proves both branch whitelists
  // reject raw fields rather than accepting or silently stripping them.
  for (const key of ['rawPrompt', 'toolArguments', 'providerError', 'absoluteRoot', 'secret']) {
    for (const value of variants) reject({ ...value, [key]: 'RAW_CANARY' }, `${value.status} raw field ${key}`, key)
    for (const nested of ['input', 'modelSelection', 'tools', 'acceptance', 'recovery']) {
      reject({ ...complete, [nested]: { ...complete[nested], [key]: 'RAW_CANARY' } }, `nested ${nested}.${key}`, key)
    }
    reject({ ...complete, tools: { ...complete.tools, denials: [{ ...complete.tools.denials[0], [key]: 'RAW_CANARY' }] } }, `nested denial.${key}`, key)
  }
  for (const [label, value] of [
    ['null', null],
    ['array', []],
    ['string', 'unavailable'],
    ['number', 0],
    ['boolean', true],
    ['missing status', {}],
    ['unknown status', { status: 'unknown' }],
    ['missing available fields', { status: 'available' }],
    ['input type', { ...available, input: { ...available.input, type: 'unknown' } }],
    ['string byte count', { ...available, input: { ...available.input, bytes: '2' } }],
    ['negative byte count', { ...available, input: { ...available.input, bytes: -1 } }],
    ['fractional byte count', { ...available, input: { ...available.input, bytes: 1.5 } }],
    ['input digest', { ...available, input: { ...available.input, sha256: 'bad' } }],
    ['resource digest', { ...available, resourceDigests: { '用户.resource/任意-id': 'bad' } }],
    ['model provider type', { ...complete, modelSelection: { ...complete.modelSelection, provider: 12 } }],
    ['reasoning effort type', { ...complete, modelSelection: { ...complete.modelSelection, reasoningEffort: 12 } }],
    ['tool names type', { ...available, tools: { effectiveNames: 'fixture-tool' } }],
    ['acceptance count', { ...available, acceptance: { code: 'passed', issueCount: -1 } }]
  ]) {
    reject(value, label)
  }
})
test('C-07 diagnostics presentation capability: existing panel must consume durable diagnostics', () => {
  const source = readFileSync(new URL('../../src/client/features/authoring/ui/panel/panel-controller.tsx', import.meta.url), 'utf8')
  assert.equal(/\bdiagnostics\b/.test(source), true, 'C-07 DIAGNOSTICS_NOT_RENDERED: existing Attempt presentation only displays outputJson/errorCode')
  // This explicit source capability is intentionally NOT a rendering/browser
  // green. W3 collector must inspect real zh/en UI, reload and raw sentinels.
})
test('C-08 preservation: public DTO/model read old records without diagnosing fictional success', () => {
  const codec = BLUEPRINT_INVOCATIONS.find(i => i.method === 'inspectRun').result.create()
  const legacy = {
    runId: 'legacy-run',
    state: 'recovery_required',
    seq: 3,
    definitionRevision: 'sem-old',
    attempts: [{ nodeId: 'old', attempt: 1, state: 'recovery_required' }],
    logTail: []
  }
  const dto = codec.parse(legacy),
    model = new BlueprintClientModel()
  model.applySnapshot(dto)
  assert.deepEqual(model.view, legacy)
  assert.equal(model.view.attempts[0].diagnostics, undefined)
  assert.equal(model.view.attempts[0].outputJson, undefined)
  assert.equal(model.view.state, 'recovery_required')
  assert.equal(codec.safeParse({ ...legacy, attempts: [{ ...legacy.attempts[0], rawPrompt: 'RAW_SECRET' }] }).success, false)
})
test('C-07/C-08 preservation: zh/en presentation does not change payload, semantic revision, selection, input, history or Run binding', async t => {
  const { workspace, calls } = await workspaceFixture()
  const editor = workspace.editor
  editor.moveNode('source', 310, 220)
  editor.commitLayout()
  editor.setSelection(['source'])
  workspace.inputJson = '{"用户.port":"opaque 用户输入"}'
  workspace.runId = 'retained-run'
  workspace.model.applySnapshot({
    runId: 'retained-run',
    state: 'waiting_input',
    seq: 7,
    definitionRevision: workspace.document.semanticRevision,
    attempts: [{ nodeId: 'source', attempt: 1, state: 'waiting_input' }],
    logTail: []
  })
  const before = {
    payload: json(editor.exportDefinition()),
    input: workspace.inputJson,
    selected: [...editor.selection],
    layout: editor.exportLayout(),
    canUndo: editor.canUndo,
    canRedo: editor.canRedo,
    runId: workspace.runId,
    view: structuredClone(workspace.model.view),
    calls: calls.length
  }
  const revisionRoot = mkdtempSync(join(tmpdir(), 'bp-flow-revision-'))
  t.after(() => rmSync(revisionRoot, { recursive: true, force: true }))
  const semantic = computeRevision({ rootDir: revisionRoot, definition: editor.exportDefinition() }).semantic
  const inspector = new InspectorSession(editor, 'source')
  inspector.setJson('options', '{"outputs":{"用户.port":"string"}}')
  const inspectorBefore = structuredClone(inspector.getSnapshot())
  for (const dictionary of [zh, en, zh]) {
    const translate = (key, params = {}) => (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
    assert.equal(typeof editorNodeDisplayTitle(editor.nodes[0], 0, translate), 'string')
    assert.equal(typeof runStateTitle('waiting_input', translate), 'string')
    assert.equal(typeof flowAriaLabels(translate)['controls.zoomIn.ariaLabel'], 'string')
    const markup = renderToStaticMarkup(renderNodeInspector({ node: editor.nodes[0], editor, resources: {}, t: translate }, inspector, inspector.getSnapshot()))
    assert.ok(markup.includes('用户.port'))
    assert.deepEqual(inspector.getSnapshot(), inspectorBefore)
    assert.equal(json(editor.exportDefinition()), before.payload)
    assert.equal(computeRevision({ rootDir: revisionRoot, definition: editor.exportDefinition() }).semantic, semantic)
    assert.deepEqual([...editor.selection], before.selected)
    assert.deepEqual(editor.exportLayout(), before.layout)
    assert.equal(workspace.inputJson, before.input)
    assert.equal(editor.canUndo, before.canUndo)
    assert.equal(editor.canRedo, before.canRedo)
    assert.equal(workspace.runId, before.runId)
    assert.deepEqual(workspace.model.view, before.view)
    assert.equal(calls.length, before.calls, 'CONTROL: presentation cannot issue a Host command')
  }
  const layoutOnly = editor.exportDefinition()
  layoutOnly.presentation.nodes.source = { x: 999, y: 888 }
  assert.equal(computeRevision({ rootDir: revisionRoot, definition: layoutOnly }).semantic, semantic)
  assert.equal(editor.undo(), true, 'CONTROL: locale did not erase history')
  assert.equal(editor.redo(), true)
  // ReactFlow viewport is owned by the live provider, not workspace/editor.
  // Its locale lifetime is explicitly a W3 installed-browser gate; source-only
  // node coordinates/selection preservation above must not be called viewport QA.
})
