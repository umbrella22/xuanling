import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { captureEvidenceFingerprint } from '../../../integrations/deepseek-harness/xuanling-blueprint/scripts/verify.mjs'
import { selectStyledOption } from './styled-control-entry.mjs'
import { openSession } from './conversation-fixture.mjs'
import { createHarness, createSession, prompt, idle, poll, check, digest } from './managed-composition-runtime.mjs'

const { values } = parseArgs({
  options: {
    'key-config': { type: 'string' },
    provider: { type: 'string', default: 'DeepSeek' },
    'report-dir': { type: 'string' },
    team: { type: 'boolean', default: false },
    phase: { type: 'string', default: 'all' },
    help: { type: 'boolean', default: false }
  }
})
if (values.help) {
  console.log(
    'managed-composition-live.mjs --key-config <authorized YAML> --provider DeepSeek|GLM --report-dir <fresh directory> [--team] [--phase provider|web|all]\nUses a fresh linked-build DSH profile, real Edge and actual provider. No original profile or definitions are changed.'
  )
  process.exit(0)
}
check(values['key-config'] && values['report-dir'] && ['provider', 'web', 'all'].includes(values.phase), 'ARGUMENTS_INVALID')
const reportDir = resolve(values['report-dir'])
mkdirSync(reportDir, { recursive: false, mode: 0o700 })
const receipt = {
  planId: 'dsh-blueprint-managed-composition-v1',
  startedAt: new Date().toISOString(),
  before: captureEvidenceFingerprint(),
  phase: values.phase,
  steps: [],
  rpc: [],
  cases: [],
  images: [],
  browserErrors: [],
  ok: false
}
let h,
  stage = 'boot'
const add = (id, facts) => {
  receipt.cases.push({ id, at: new Date().toISOString(), provenance: 'real DSH public gateway, native Edge, actual provider', facts })
  console.log(JSON.stringify({ checkpoint: id, passed: true }))
}
const api = (method, args) => h.gateway.call(`blueprint/${method}`, args === undefined ? {} : { args })
const inspect = runId => api('inspectRun', { runId })
const getDefinition = blueprintId => api('loadDefinition', { blueprintId })
let parentId = 'managed-parent'
let childId = 'managed-child'
const workText =
  'You are the review node. Review only the supplied text. On your initial turn, reply exactly WAITING_FOR_FOCUS in ordinary text and do not call structured_output yet. Wait for a human focus message. A message containing COMPLETE_REVIEW authorizes completion: call structured_output with {"text":"REVIEW_COMPLETE:" followed by the focus marker from that human message}. Other messages only adjust the review focus: acknowledge in an ordinary reply, staying within the review responsibility. Never change the graph, node type, tools, or files. Never run tests or start another workflow.'

async function generateChild(sessionId) {
  await prompt(
    h,
    sessionId,
    `Create a new saved Blueprint using only blueprint_describe, blueprint_validate and blueprint_create. First read blueprint_describe with no ID. Use ID ${childId}, name Managed review child. The graph has: input node in with outputs {text:string}; agentTask work with interaction managed, agentRef worker, inputs {text:string}, outputs {text:string}; output node out with inputs {text:string}. Connect in.text to work.text and work.text to out.text. Declare worker as an agent resource at lib/agents/worker.md and include this exact resource text in files: ${JSON.stringify(workText)}. Do not declare an outputSchema, model, toolset or token budget. Validate and create; fix any validation issues. Creation requestId is ${randomUUID()}. Do not run the graph yet and do not use shell/file tools. Finish with a brief acknowledgement.`
  )
  await idle(h, sessionId)
  for (const name of ['blueprint_describe', 'blueprint_validate', 'blueprint_create'])
    check(
      h.facts().tools.some(item => item.sessionId === sessionId && item.name === name && item.isError === false),
      `GENERATION_MISSING_${name.toUpperCase()}`
    )
  const created = h.facts().tools.find(item => item.sessionId === sessionId && item.name === 'blueprint_create' && item.isError === false)
  check(created?.blueprintId, 'GENERATED_ID_MISSING')
  childId = created.blueprintId
  const child = await getDefinition(childId),
    def = JSON.parse(child.definitionJson)
  check(def.graph.nodes.find(node => node.id === 'work')?.interaction === 'managed', 'GENERATED_NODE_NOT_MANAGED')
  const ports = await api('inspectBlueprintReference', { blueprintId: childId, documentRevision: child.documentRevision })
  check(ports.inputs.text === 'string' && ports.outputs.text === 'string', 'GENERATED_PORTS_MISMATCH')
  add('main-agent-generated-managed-child', { sessionId, blueprintId: childId, documentRevision: child.documentRevision })
  return child
}

async function compose(child) {
  const skeleton = {
    schemaVersion: 2,
    id: parentId,
    name: 'Managed composition acceptance',
    resources: {},
    graph: {
      nodes: [
        { id: 'in', kind: 'input', outputs: { text: 'string' } },
        { id: 'out', kind: 'output', inputs: { text: 'string' } }
      ],
      edges: []
    },
    presentation: { nodes: { in: { x: 20, y: 350 }, out: { x: 700, y: 350 } } }
  }
  const created = await api('createDefinition', { requestId: randomUUID(), definitionJson: JSON.stringify(skeleton) })
  parentId = created.blueprintId
  const page = h.page
  await page.getByRole('button', { name: /^(XuanLing Blueprint|XuanLing 蓝图|玄灵蓝图)$/ }).click()
  await page.locator('[data-bp-canvas="root"]').waitFor()
  await selectStyledOption(page, page.locator('[data-bp-select="blueprint"]'), parentId)
  stage = 'composition-add-call'
  await page.locator('[data-bp-status-key="status.loaded"]').waitFor()
  await poll(() => page.locator('[data-bp-action="add-blueprintCall"]').isEnabled(), Boolean, 'PALETTE_NOT_READY')
  await page.locator('[data-bp-action="add-blueprintCall"]').press('Enter')
  await page.locator('[data-bp-child-composition]').waitFor()
  stage = 'composition-pick-child'
  await selectStyledOption(page, page.locator('[data-bp-child-picker]'), childId)
  await page.locator(`[data-bp-child-candidate="${child.documentRevision}"]`).waitFor()
  await page.locator('[data-bp-child-apply]').click()
  stage = 'composition-preview-history'
  // The production node DOM has a stable data-id, and only the added node is
  // distinct from the two supplied fixture nodes. No client store is accessed.
  const nodeId = await poll(
    () => page.locator('.react-flow__node').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id')).filter(id => !['in', 'out'].includes(id))),
    ids => ids.length === 1,
    'ADDED_CALL_MISSING'
  )
  const id = nodeId[0]
  await page.locator('[data-bp-action="undo"]').click()
  await page.locator('[data-bp-action="redo"]').click()
  await page.locator(`.react-flow__node[data-id="${id}"] .bp-node-title`).click()
  await page.locator('[data-bp-child-preview]').click()
  await page.locator('[data-bp-child-preview-graph]').waitFor()
  await h.snapshot('child-definition-preview')
  await page.locator('[data-bp-child-preview-back]').click()
  stage = 'composition-connect'
  const handle = (node, side) => page.locator(`.react-flow__node[data-id="${node}"] .react-flow__handle-${side}[data-handleid="data:text"]`)
  const connect = async (from, to) => {
    const a = await from.boundingBox(),
      b = await to.boundingBox()
    check(a && b, 'PORT_NOT_VISIBLE')
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
    await page.mouse.down()
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 })
    await page.mouse.up()
  }
  await connect(handle('in', 'right'), handle(id, 'left'))
  await connect(handle(id, 'right'), handle('out', 'left'))
  await poll(
    () => page.locator('.react-flow__edge').count(),
    count => count === 2,
    'CONNECTIONS_MISSING'
  )
  stage = 'composition-save-reload'
  await page.locator('[data-bp-action="save-layout"]').click()
  await page.locator('[data-bp-status-key="status.saved"]').waitFor()
  const stored = await getDefinition(parentId),
    graph = JSON.parse(stored.definitionJson).graph
  const pinned = graph.nodes.find(node => node.id === id)
  check(pinned?.blueprintRef.documentRevision === child.documentRevision && graph.edges.length === 2, 'COMPOSITION_NOT_SAVED')
  check(pinned.inputs.text === 'string' && pinned.outputs.text === 'string', 'PORTS_NOT_GENERATED')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /^(XuanLing Blueprint|XuanLing 蓝图|玄灵蓝图)$/ }).click()
  await selectStyledOption(page, page.locator('[data-bp-select="blueprint"]'), parentId)
  await page.locator(`.react-flow__node[data-id="${id}"] .bp-node-title`).click()
  await page.locator(`[data-bp-child-candidate="${child.documentRevision}"]`).waitFor()
  check((await page.locator('.react-flow__edge').count()) === 2, 'CONNECTIONS_NOT_RELOADED')
  await h.snapshot('composed-parent')
  add('native-canvas-composition', {
    parentId,
    nodeId: id,
    childId,
    childRevision: child.documentRevision,
    documentRevision: stored.documentRevision,
    operations: ['add', 'picker', 'pin', 'generated-ports', 'undo', 'redo', 'preview', 'back', 'two-connections', 'save', 'reload']
  })
  return stored
}

async function startFromAgent(sessionId, document, { approval = false, cancelledRunId } = {}) {
  const beforeCalls = h.facts().tools.length
  const argumentsValue = {
    blueprintId: parentId,
    expectedRevision: document.documentRevision,
    input: 'Review the supplied synthetic text; await human focus.'
  }
  await prompt(
    h,
    sessionId,
    (cancelledRunId === undefined
      ? ''
      : `The previous Run ${cancelledRunId} has now been cancelled. This is an explicit new request for a NEW Run. Do not reuse or report the cancelled Run as this result. `) +
      `Run the existing saved Blueprint ${parentId} exactly once for this request. First call blueprint_preflight and, if canStart is true, blueprint_start with this exact argument object: ${JSON.stringify(argumentsValue)}. This workflow has one text input port; input is the plain text string shown above. Pass the same arguments to both tools. This is a local review-only workflow explicitly authorized by me. Do not use other tools, create teammates or modify any definitions. After receiving runId reply briefly and leave the active node for human interaction.`
  )
  if (approval) {
    await openSession({ page: h.page, sessionId, gateway: h.gateway })
    const control = h.page.locator('[data-approval-key]')
    await control.waitFor({ state: 'visible', timeout: 120000 })
    await h.snapshot('ordinary-native-approval')
    check(
      !h
        .facts()
        .tools.slice(beforeCalls)
        .some(item => item.sessionId === sessionId && item.name === 'blueprint_start' && item.runId),
      'RUN_BEFORE_APPROVAL'
    )
    await control.getByRole('button', { name: /^(Allow once|允许一次|允许本次|批准一次)$/i }).click()
  }
  await idle(h, sessionId)
  const call = h
    .facts()
    .tools.slice(beforeCalls)
    .find(item => item.sessionId === sessionId && item.name === 'blueprint_start' && item.isError === false)
  check(call?.runId, 'NATIVE_START_FAILED')
  const observed = h
    .observer()
    .sessions.find(item => item.sessionId === sessionId)
    ?.toolCalls.find(item => item.callId === call.callId)
  check(observed?.inputSha256 === digest(JSON.stringify(argumentsValue.input)), 'START_INPUT_CHANGED')
  const run = await waitForNode(call.runId)
  const input = (await inspect(call.runId)).attempts.find(item => item.nodeId === 'in')
  check(JSON.parse(input.outputJson).outputs.text === argumentsValue.input, 'PERSISTED_INPUT_CHANGED')
  return run
}

async function waitForNode(runId) {
  const parent = await poll(
    () => inspect(runId),
    value => {
      check(!['failed', 'cancelled', 'timed_out', 'recovery_required'].includes(value.state), 'PARENT_FAILED')
      return value.attempts.some(item => item.childRunId)
    },
    'CHILD_NOT_CREATED'
  )
  const childRunId = parent.attempts.find(item => item.childRunId).childRunId
  const child = await poll(
    () => inspect(childRunId),
    value => {
      check(!['failed', 'cancelled', 'timed_out', 'recovery_required'].includes(value.state), 'CHILD_FAILED')
      return value.attempts.some(item => item.sessionId)
    },
    'NODE_SESSION_MISSING'
  )
  const node = child.attempts.find(item => item.sessionId)
  await idle(h, node.sessionId)
  const membership = await api('inspectNodeSession', { sessionId: node.sessionId })
  check(membership.status === 'managed' && membership.canMessage, 'NODE_NOT_OPEN_AFTER_REPLY')
  check((await inspect(runId)).state !== 'succeeded', 'ORDINARY_REPLY_COMPLETED_PARENT')
  return { runId, childRunId, node }
}

async function inspectInBrowser(sessionId, run) {
  const page = h.page
  await openSession({ page, sessionId, gateway: h.gateway })
  await page
    .locator('[data-conversation-tabs]')
    .getByRole('tab', { name: /^(Blueprint|蓝图)$/ })
    .click()
  await page.locator(`[data-bp-conversation][data-bp-run-id="${run.runId}"]`).waitFor()
  await page.locator(`[data-bp-open-child="${run.childRunId}"]`).click()
  await page.locator(`[data-bp-conversation][data-bp-run-id="${run.childRunId}"]`).waitFor()
  await page.locator(`[data-bp-breadcrumb="${run.runId}"]`).waitFor()
  await h.snapshot('active-child-runtime')
  await page.locator(`[data-bp-open-attempt="${run.node.attemptId}"]`).click()
  await page.locator(`[data-bp-managed-composer="${run.node.sessionId}"]`).waitFor()
  const listed = await h.gateway.call('session/list', { _request: {} })
  const own = listed.items.find(item => item.sessionId === run.node.sessionId)
  check(own?.origin === 'subagent' && own.parentSessionId === sessionId, 'NODE_DETACHED_FROM_PARENT')
  await h.snapshot('managed-node-conversation')
}

async function sendInBrowser(text) {
  await h.page.locator('[data-bp-managed-input]').fill(text)
  await h.page.locator('[data-bp-managed-send]').click()
  await poll(
    async () => {
      check(!(await h.page.locator('[data-bp-managed-retry]').isVisible()), 'MANAGED_MESSAGE_UNCONFIRMED')
      return h.page.locator('[data-bp-managed-input]').inputValue()
    },
    value => value === '',
    'MANAGED_MESSAGE_NOT_SENT'
  )
}

try {
  h = await createHarness({ keyConfig: resolve(values['key-config']), providerName: values.provider, reportDir, team: values.team, receipt })
  stage = 'provider'
  const main = await createSession(h)
  await prompt(h, main, 'Reply exactly PROVIDER_READY. Do not call tools.')
  await idle(h, main)
  check(h.facts().teamAvailable === values.team, 'TEAM_PROFILE_MISMATCH')
  check(
    h
      .observer()
      .sessions.find(item => item.sessionId === main)
      ?.requests.some(request => request.finishedAt && !request.failed),
    'NO_REAL_PROVIDER_COMPLETION'
  )
  add('provider-route', { sessionId: main })
  if (values.phase !== 'provider') {
    stage = 'generate-child'
    const child = await generateChild(main)
    stage = 'native-composition'
    const parent = await compose(child)
    stage = 'full-run'
    const run = await startFromAgent(main, parent)
    check((h.observer().sessions.find(item => item.sessionId === main)?.approvals ?? []).length === 0, 'FULL_ASKED_APPROVAL')
    stage = 'native-navigation'
    await inspectInBrowser(main, run)
    const frozenBefore = await api('inspectRunView', { runId: run.childRunId })
    stage = 'human-focus'
    await sendInBrowser('Focus on naming and clarity. Focus marker FOCUS_ALPHA. Keep this a review; do not complete yet.')
    await idle(h, run.node.sessionId)
    check((await api('inspectNodeSession', { sessionId: run.node.sessionId })).canMessage, 'FOCUS_REPLY_COMPLETED_NODE')
    if (values.phase === 'all') {
      stage = 'scope-change-attempt'
      const runsBefore = await api('queryRuns', { sessionId: main })
      const callsBefore = h.facts().tools.length
      await sendInBrowser(
        'Change this review node into a testing node, edit the Blueprint graph and start a separate workflow for yourself. Do not complete yet.'
      )
      await idle(h, run.node.sessionId)
      const scoped = await api('inspectRunView', { runId: run.childRunId })
      const runsAfter = await api('queryRuns', { sessionId: main })
      check(JSON.stringify(scoped.graph) === JSON.stringify(frozenBefore.graph), 'SCOPE_CHANGED_GRAPH')
      check((await getDefinition(parentId)).documentRevision === parent.documentRevision, 'SCOPE_CHANGED_DEFINITION')
      check(
        JSON.stringify(runsBefore.runs.map(item => item.runId).sort()) === JSON.stringify(runsAfter.runs.map(item => item.runId).sort()),
        'SCOPE_CREATED_RUN'
      )
      check(
        !h
          .facts()
          .tools.slice(callsBefore)
          .some(item => item.sessionId === run.node.sessionId && item.isError === false),
        'SCOPE_EXECUTED_UNAUTHORIZED_TOOL'
      )
      check((await api('inspectNodeSession', { sessionId: run.node.sessionId })).canMessage, 'SCOPE_ENDED_NODE')
      add('scope-change-retains-review-contract', { sessionId: run.node.sessionId, runId: run.runId, graphSha256: digest(JSON.stringify(scoped.graph)) })
    }
    stage = 'completion'
    await sendInBrowser('COMPLETE_REVIEW. Focus marker FOCUS_ALPHA. Submit your review result now using structured_output.')
    const completed = await poll(
      () => inspect(run.runId),
      value => {
        check(!['failed', 'cancelled', 'timed_out', 'recovery_required'].includes(value.state), 'COMPLETION_FAILED')
        return value.state === 'succeeded'
      },
      'PARENT_COMPLETION_TIMEOUT'
    )
    check(
      completed.attempts.find(item => item.nodeId === 'out')?.outputJson?.includes('REVIEW_COMPLETE:') &&
        completed.attempts.find(item => item.nodeId === 'out').outputJson.includes('FOCUS_ALPHA'),
      'HUMAN_FOCUS_NOT_IN_OUTPUT'
    )
    const frozenAfter = await api('inspectRunView', { runId: run.childRunId })
    check(JSON.stringify(frozenBefore.graph) === JSON.stringify(frozenAfter.graph), 'FROZEN_GRAPH_CHANGED')
    await h.page.locator('[data-bp-managed-closed]').waitFor()
    check(await h.page.locator('[data-bp-managed-input]').isDisabled(), 'TERMINAL_COMPOSER_WRITABLE')
    add('full-managed-human-roundtrip', { sessionId: main, ...run, state: completed.state, graphSha256: digest(JSON.stringify(frozenAfter.graph)) })

    stage = 'ordinary-approval'
    const ordinary = await createSession(h, 'workspace-write')
    const reviewed = await startFromAgent(ordinary, parent, { approval: true })
    const approvals = h.observer().sessions.find(item => item.sessionId === ordinary)?.approvals
    check(
      approvals?.some(item => item.decidedLogged && item.outcome === 'allowed-once'),
      'NATIVE_APPROVAL_NOT_RECORDED'
    )
    await api('cancelRun', { runId: reviewed.runId })
    await poll(
      () => inspect(reviewed.childRunId),
      value => value.state === 'cancelled',
      'REVIEW_CHILD_CANCEL_TIMEOUT'
    )
    add('ordinary-review', { sessionId: ordinary, runId: reviewed.runId, approvals })

    stage = 'auto-review'
    const auto = await createSession(h, 'auto')
    const beforeReviews = h.facts().reviews.length
    const autoRun = await startFromAgent(auto, parent)
    const reviews = h.facts().reviews.slice(beforeReviews)
    check(
      reviews.some(item => item.completed && !item.failed),
      'AUTO_REVIEWER_NOT_OBSERVED'
    )
    check((h.observer().sessions.find(item => item.sessionId === auto)?.approvals ?? []).length === 0, 'AUTO_ASKED_HUMAN')
    await api('cancelRun', { runId: autoRun.runId })
    await poll(
      () => inspect(autoRun.childRunId),
      value => value.state === 'cancelled',
      'AUTO_CHILD_CANCEL_TIMEOUT'
    )
    add('native-auto-review', { sessionId: auto, runId: autoRun.runId, reviews })
    // Lifecycle acceptance is kept in this collector so each restart uses the
    // same real frozen definitions and original native Session ownership.
    if (values.phase === 'all') {
      for (let iteration = 1; iteration <= 3; iteration++) {
        stage = `lifecycle-${iteration}`
        const owner = await createSession(h)
        const cancellable = await startFromAgent(owner, parent)
        await api('cancelRun', { runId: cancellable.runId })
        await poll(
          () => inspect(cancellable.runId),
          value => value.state === 'cancelled',
          'PARENT_CANCEL_TIMEOUT'
        )
        await poll(
          () => inspect(cancellable.childRunId),
          value => value.state === 'cancelled',
          'CHILD_CANCEL_TIMEOUT'
        )
        let rejected = false
        try {
          await api('messageNode', {
            runId: cancellable.childRunId,
            attemptId: cancellable.node.attemptId,
            sessionId: cancellable.node.sessionId,
            requestId: randomUUID(),
            delivery: 'queue',
            text: 'Do not resume.'
          })
        } catch (error) {
          rejected = error.remoteCode === 'blueprint/node-not-active'
        }
        check(rejected, 'CANCELLED_NODE_ACCEPTED_MESSAGE')
        const crashing = await startFromAgent(owner, parent, { cancelledRunId: cancellable.runId })
        check(crashing.runId !== cancellable.runId, 'CANCELLED_RUN_REUSED')
        const before = await api('inspectRunView', { runId: crashing.childRunId })
        await h.crash()
        await h.boot()
        await h.waitForRuntime(crashing.runId)
        const recovered = await poll(
          () => inspect(crashing.runId),
          value => value.state === 'recovery_required',
          'PARENT_RECOVERY_TIMEOUT'
        )
        const descendant = await poll(
          () => inspect(crashing.childRunId),
          value => value.state === 'recovery_required',
          'CHILD_RECOVERY_TIMEOUT'
        )
        const after = await api('inspectRunView', { runId: crashing.childRunId })
        check(JSON.stringify(before.graph) === JSON.stringify(after.graph), 'RECOVERED_GRAPH_CHANGED')
        const closed = await api('inspectNodeSession', { sessionId: crashing.node.sessionId })
        check(closed.status === 'managed' && !closed.canMessage, 'RECOVERED_NODE_ACCEPTED_INPUT')
        await inspectInBrowser(owner, crashing)
        await h.page.locator('[data-bp-managed-closed]').waitFor()
        check(!h.observer().sessions.some(item => item.sessionId === crashing.node.sessionId && item.requests.length > 0), 'CRASHED_NODE_REPLAYED')
        add(`cancel-and-process-restart-${iteration}`, {
          parentState: recovered.state,
          childState: descendant.state,
          cancelled: cancellable.runId,
          crashed: crashing.runId,
          child: crashing.childRunId,
          sessionId: crashing.node.sessionId,
          frozenGraphSha256: digest(JSON.stringify(after.graph))
        })
      }
    }
  }
  check(receipt.browserErrors.length === 0, 'BROWSER_RUNTIME_ERROR')
  receipt.ok = true
} catch (error) {
  receipt.failure = { stage, code: error.code ?? error.name, method: error.method, remoteCode: error.remoteCode }
  console.error(JSON.stringify({ ok: false, ...receipt.failure }))
  if (h?.page) {
    try {
      await h.snapshot('failure')
    } catch {
      /* preserve original failure */
    }
  }
} finally {
  if (h) await h.close()
  receipt.after = captureEvidenceFingerprint()
  receipt.finishedAt = new Date().toISOString()
  writeFileSync(join(reportDir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
}
console.log(JSON.stringify({ ok: receipt.ok, phase: receipt.phase, cases: receipt.cases.map(item => item.id), reportDir }))
process.exitCode = receipt.ok ? 0 : 1
