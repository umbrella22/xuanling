import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensure, sha256, identical, confined, assertPhysicalPath, readArtifact } from './conversation-evidence.mjs'
import { APPROVAL_FILE_CONTENT } from './conversation-runtime.mjs'

export const CONVERSATION_ROOT = '[data-bp-conversation="root"]'
export const COMPOSER = '[data-composer-input][role="textbox"]'
const BLUEPRINT_TAB = /^(?:Blueprint|XuanLing Blueprint|蓝图|玄灵蓝图)$/i
const CHAT_TAB = /^(?:Chat|对话|聊天)$/i
const mutation = method => /(?:^|\/)(?:startRun|startSessionRun|cancelRun|decide|retry|prompt|cancel|updateQueue)$/.test(method)

// Carrier metadata only: no args, payload, response bodies, prompt, headers or URL.
export function observeNativeRequests(page) {
  const requests = [], listeners = []
  const take = (value, carrier) => {
    if (!value || typeof value.method !== 'string' || typeof value.rpcId !== 'string') return
    if (!['client-request', 'client-stream-request'].includes(value.type)) return
    requests.push({ method: value.method, rpcId: value.rpcId, carrier, at: new Date().toISOString(), mutation: mutation(value.method) })
  }
  const request = item => { try { if (item.method() === 'POST' && new URL(item.url()).pathname.startsWith('/api/')) take(item.postDataJSON(), 'HTTP') } catch { /* not an RPC */ } }
  const socket = ws => {
    const sent = event => { try { take(JSON.parse(String(event.payload)), 'WebSocket') } catch { /* not an RPC */ } }
    ws.on('framesent', sent); listeners.push(() => ws.off('framesent', sent))
  }
  page.on('request', request); page.on('websocket', socket)
  return { requests, mutations: () => requests.filter(item => item.mutation).length,
    stop: () => { page.off('request', request); page.off('websocket', socket); for (const remove of listeners) remove() } }
}
export function publicObserverSnapshot(path) {
  assertPhysicalPath(path)
  const facts = JSON.parse(readFileSync(path, 'utf8'))
  ensure(facts?.provenance === 'public DSH observer' && Array.isArray(facts.sessions), 'EVIDENCE_OBSERVER_MISSING')
  return facts
}
export function streamObservation(facts, sessionId) {
  const owner = facts.sessions.find(session => session.sessionId === sessionId)
  const request = owner?.requests.at(-1)
  return { sessionId, totalCalls: facts.sessions.reduce((sum, session) => sum + session.requests.length, 0),
    identities: facts.sessions.flatMap(session => session.requests.map(item => item.identity)).sort(),
    requestIdentity: request?.identity ?? null, active: request?.active === true, textDeltas: request?.textDeltas ?? 0,
    failed: request?.failed === true || owner?.runtimeError === true, at: facts.at }
}
export function approvalObservation(facts, sessionId) {
  const value = facts.sessions.find(session => session.sessionId === sessionId)?.approvals.at(-1)
  ensure(value?.auditId && value.callId, 'EVIDENCE_APPROVAL_IDENTITY_MISSING')
  return { sessionId, auditId: value.auditId, callId: value.callId, pending: value.pending, outcome: value.outcome,
    askedSeq: value.askedSeq, decidedSeq: value.decidedSeq, decidedLogged: value.decidedLogged, at: facts.at }
}
export function approvalSettlementObservation(facts, sessionId, approval, root) {
  const call = facts.sessions.find(session => session.sessionId === sessionId)?.toolCalls.find(item => item.callId === approval.callId && item.name === 'write')
  ensure(approval.sessionId === sessionId && approval.outcome === 'allowed-once' && approval.decidedLogged === true
    && call?.callLogged && call.resultLogged && call.ok === true && call.isError === false
    && call.pipelineResultObserved === true && call.pipelineIsError === false
    && Number.isInteger(call.resultSeq) && Number.isInteger(approval.decidedSeq)
    && call.resultSeq > approval.decidedSeq, 'EVIDENCE_NATIVE_APPROVAL_TOOL_NOT_SETTLED')
  let bytes
  try { bytes = readArtifact(root, join(root, 'cwd/native-approval.txt')) }
  catch (error) { if (error.code === 'ENOENT') ensure(false, 'EVIDENCE_NATIVE_APPROVAL_FILE_MISSING'); throw error }
  ensure(bytes.equals(Buffer.from(APPROVAL_FILE_CONTENT)), 'EVIDENCE_NATIVE_APPROVAL_EFFECT_MISMATCH')
  return { tool: { name: call.name, callId: call.callId, callSeq: call.callSeq, resultSeq: call.resultSeq,
    isError: call.isError, pipelineIsError: call.pipelineIsError, pipelineResultObserved: call.pipelineResultObserved },
  effect: { category: 'isolated-native-write', sha256: sha256(bytes), bytes: bytes.length } }
}
export function conversationDomProbe() {
  const root = document.querySelector('[data-bp-conversation="root"]')
  if (!root) return null
  return { sessionId: root.getAttribute('data-bp-session'), runId: root.getAttribute('data-bp-run-id'),
    revision: root.getAttribute('data-bp-frozen-revision'),
    nodes: [...root.querySelectorAll('[data-bp-node]')].map(node => ({ nodeId: node.getAttribute('data-bp-node'), state: node.getAttribute('data-bp-raw-state') })),
    attempts: [...root.querySelectorAll('[data-bp-attempt-id]')].map(item => item.getAttribute('data-bp-attempt-id')),
    nestedComposers: root.querySelectorAll('[data-composer-input]').length }
}
export function conversationDomReadyForSession(dom, sessionId, inspected) {
  if (dom?.sessionId !== sessionId) return false
  if (inspected?.status === 'unbound') return !dom.runId && !dom.revision
  if (inspected?.status !== 'bound') return false
  const run = inspected.selected?.run
  return dom.runId === run?.runId && dom.revision === run?.definitionRevision
}
export function projectInspection(value, dom) {
  ensure(value?.status === 'bound' && dom?.sessionId === value.sessionId, 'EVIDENCE_BOUND_SESSION_MISMATCH')
  const { run, graph, focusAttemptIds, source } = value.selected
  ensure(dom.runId === run.runId && dom.revision === run.definitionRevision, 'EVIDENCE_DOM_RUN_MISMATCH')
  ensure(identical(dom.nodes.map(item => item.nodeId).sort(), graph.nodes.map(item => item.id).sort()), 'EVIDENCE_DOM_GRAPH_MISMATCH')
  ensure(dom.nestedComposers === 0 && focusAttemptIds.every(id => dom.attempts.includes(id)), 'EVIDENCE_DOM_FOCUS_MISSING')
  const focus = run.attempts.filter(item => focusAttemptIds.includes(item.attemptId))
  const latest = new Map()
  for (const attempt of run.attempts) if (!latest.has(attempt.nodeId) || latest.get(attempt.nodeId).attempt < attempt.attempt) latest.set(attempt.nodeId, attempt)
  for (const node of dom.nodes) if (latest.has(node.nodeId)) ensure(node.state === latest.get(node.nodeId).state, 'EVIDENCE_DOM_NODE_STATE_MISMATCH')
  return { sessionId: value.sessionId, runId: run.runId, revision: run.definitionRevision,
    graphSha256: sha256(JSON.stringify(graph)), nodeIds: graph.nodes.map(item => item.id).sort(), focusAttemptIds: [...focusAttemptIds].sort(),
    attempts: focus.map(item => ({ attemptId: item.attemptId, sessionId: item.sessionId ?? null, nodeId: item.nodeId })),
    source: source ? { sessionId: source.sessionId, kind: source.kind, callId: source.callId ?? null, turn: source.turn ?? null } : null }
}
async function screenshot(page, root, name) {
  const path = join(root, `${name}.png`)
  // Test prompts are operator-controlled. Hide editable user text and approval
  // details; retain tab/root/node/Attempt and approval key surfaces.
  await page.screenshot({ path, mask: [page.locator(COMPOSER), page.locator('[data-approval-scroll]')], fullPage: false })
  return { path, sha256: sha256(readFileSync(path)), at: new Date().toISOString(), provenance: 'actual Playwright native Edge screenshot' }
}
async function selectTab(page, name) {
  const tab = page.locator('[data-conversation-tabs]').getByRole('tab', { name })
  ensure(await tab.count() === 1, 'BROWSER_NATIVE_TAB_MISSING')
  await tab.click()
  ensure(await tab.getAttribute('aria-selected') === 'true', 'BROWSER_NATIVE_TAB_NOT_SELECTED')
}
async function poll(read, predicate, code, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (Date.now() < deadline && predicate(value)) return value
    await new Promise(done => setTimeout(done, 50))
  }
  ensure(false, code)
}
export async function runConversationBrowser({ page, gateway, fixture, profile, root, reportDir, mode, receipt, inspectCodec, native, restartHost }) {
  const readObserver = () => publicObserverSnapshot(profile.observerFile)
  const at = () => new Date().toISOString()
  const add = (id, facts, image) => receipt.cases.push({ id, at: at(), provenance: 'actual native browser + public gateway', facts, screenshot: image })
  const inspect = async sessionId => inspectCodec.parse(await gateway.call('blueprint/inspectSession', { args: { sessionId } }))
  const view = async sessionId => {
    await fixture.openSession({ page, sessionId, gateway })
    ensure(new URL(page.url()).origin === gateway.origin, 'BROWSER_FOREIGN_ORIGIN')
    await selectTab(page, BLUEPRINT_TAB)
    const inspected = await inspect(sessionId)
    await page.locator(CONVERSATION_ROOT).waitFor({ state: 'visible', timeout: 15000 })
    return await poll(() => page.evaluate(conversationDomProbe),
      dom => conversationDomReadyForSession(dom, sessionId, inspected),
      inspected.status === 'bound' ? 'EVIDENCE_DOM_RUN_MISMATCH' : 'BROWSER_NATIVE_SESSION_MISMATCH')
  }
  let scene
  try {
    scene = await fixture.arrange({ page, gateway, root, mode })
    ensure(scene?.sessionId && scene.plainSessionId && scene.sessionId !== scene.plainSessionId && scene.blueprintId, 'FIXTURE_SCENE_INVALID')
    receipt.sessionId = scene.sessionId
    const first = await view(scene.sessionId)
    ensure(first.sessionId === scene.sessionId && first.nestedComposers === 0, 'BROWSER_NATIVE_SESSION_MISMATCH')
    add('native-tab', { sessionId: scene.sessionId, viewId: 'xuanling-blueprint', nativeTab: true,
      nestedComposers: first.nestedComposers }, await screenshot(page, reportDir, 'native-tab'))

    await selectTab(page, CHAT_TAB)
    const composer = page.locator(COMPOSER), draft = `conversation-collector-draft-${randomUUID()}`
    ensure(await composer.count() === 1, 'BROWSER_NATIVE_COMPOSER_MISSING')
    await composer.fill(draft)
    const digestDraft = async () => sha256(await composer.innerText())
    const beforeDraft = await digestDraft()
    await selectTab(page, BLUEPRINT_TAB)
    const switchedDraft = await digestDraft()
    await selectTab(page, CHAT_TAB)
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
    await composer.waitFor({ state: 'visible', timeout: 15000 })
    // Wait for the persisted draft hydration rather than accepting an empty edit.
    const reloadedDraft = await poll(digestDraft, value => value === beforeDraft, 'BROWSER_DRAFT_NOT_RESTORED')
    add('native-draft', { sessionId: scene.sessionId, nativeComposerCount: await composer.count(),
      beforeSha256: beforeDraft, switchedSha256: switchedDraft, reloadedSha256: reloadedDraft }, await screenshot(page, reportDir, 'native-draft'))

    if (mode === 'live') {
      ensure(typeof fixture.startStreaming === 'function' && typeof fixture.startApproval === 'function', 'FIXTURE_LIVE_HOOKS_MISSING')
      const started = await fixture.startStreaming({ page, gateway, root, scene })
      // Hooks return locators only, never evidence. Verify them through Host.
      if (started?.sessionId) scene.streamSessionId = started.sessionId
      const streamSessionId = scene.streamSessionId ?? scene.sessionId
      await view(streamSessionId)
      await poll(() => readObserver(), facts => streamObservation(facts, streamSessionId).active && streamObservation(facts, streamSessionId).textDeltas > 0, 'PROVIDER_STREAM_NOT_OBSERVED')
      const switches = []
      for (let i = 0; i < 10; i++) {
        const before = streamObservation(readObserver(), streamSessionId), mutationsBefore = native.mutations()
        await selectTab(page, CHAT_TAB)
        await selectTab(page, BLUEPRINT_TAB)
        const after = streamObservation(readObserver(), streamSessionId)
        switches.push({ ordinal: i + 1, before, after, mutationDelta: native.mutations() - mutationsBefore })
        ensure(before.active && after.active && !before.failed && !after.failed && identical(before.identities, after.identities)
          && before.totalCalls === after.totalCalls && before.requestIdentity === after.requestIdentity && native.mutations() === mutationsBefore, 'EVIDENCE_STREAM_SWITCH_FAILED')
      }
      add('stream-switch-10', { sessionId: streamSessionId, switches }, await screenshot(page, reportDir, 'stream-switch-10'))

      const approvalStart = await fixture.startApproval({ page, gateway, root, scene })
      const approvalSessionId = approvalStart?.sessionId ?? scene.sessionId
      await view(approvalSessionId)
      const approval = page.locator('[data-approval-key]')
      await approval.waitFor({ state: 'visible', timeout: 15000 })
      const before = approvalObservation(readObserver(), approvalSessionId), key = await approval.getAttribute('data-approval-key'), identities = []
      for (let i = 0; i < 10; i++) {
        const mutationsBefore = native.mutations()
        await selectTab(page, CHAT_TAB); await selectTab(page, BLUEPRINT_TAB)
        const observed = approvalObservation(readObserver(), approvalSessionId)
        identities.push({ nativeKey: await approval.getAttribute('data-approval-key'), observed, mutationDelta: native.mutations() - mutationsBefore })
        ensure(identities.at(-1).nativeKey === key && observed.pending && observed.auditId === before.auditId && observed.callId === before.callId
          && native.mutations() === mutationsBefore, 'EVIDENCE_APPROVAL_RETENTION_FAILED')
      }
      const image = await screenshot(page, reportDir, 'native-approval')
      // Real native button, never a fixture-owned settlement function.
      const allow = approval.getByRole('button', { name: /^(?:Allow once|允许一次|允许本次|批准一次)$/i })
      ensure(await allow.count() === 1, 'BROWSER_NATIVE_APPROVAL_BUTTON_MISSING')
      await allow.click()
      const settled = await poll(() => readObserver(), facts => approvalObservation(facts, approvalSessionId).decidedLogged === true, 'EVIDENCE_APPROVAL_NOT_SETTLED')
      const after = approvalObservation(settled, approvalSessionId)
      const toolSettled = await poll(() => readObserver(), facts => {
        const call = facts.sessions.find(item => item.sessionId === approvalSessionId)?.toolCalls.find(item => item.callId === after.callId)
        return call?.resultLogged && typeof call.pipelineIsError === 'boolean'
      }, 'EVIDENCE_NATIVE_APPROVAL_TOOL_NOT_SETTLED')
      const effect = approvalSettlementObservation(toolSettled, approvalSessionId, after, root)
      add('native-approval', { sessionId: approvalSessionId, nativeKey: key, before, identities, after, ...effect }, image)
    }

    const targetSessionId = scene.executionSessionId ?? scene.streamSessionId ?? scene.sessionId
    const beforeDom = await view(targetSessionId), before = projectInspection(await inspect(targetSessionId), beforeDom)
    ensure(before.focusAttemptIds.length > 0 && (mode !== 'live' || before.attempts.every(item => item.sessionId)), 'EVIDENCE_ATTEMPT_FOCUS_MISSING')
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.locator(CONVERSATION_ROOT).waitFor({ state: 'visible', timeout: 15000 })
    const after = projectInspection(await inspect(targetSessionId), await page.evaluate(conversationDomProbe))
    ensure(identical(before, after), 'EVIDENCE_ATTEMPT_REFRESH_CHANGED')
    add('refresh-attempt', { before, after, executionSessionEvidence: mode === 'live' }, await screenshot(page, reportDir, 'refresh-attempt'))

    ensure(confined(root, scene.definitionPath), 'FIXTURE_DEFINITION_OUTSIDE_ISOLATION'); assertPhysicalPath(scene.definitionPath)
    const original = readFileSync(scene.definitionPath), definition = JSON.parse(original)
    const liveBefore = await gateway.call('blueprint/loadDefinition', { args: { blueprintId: scene.blueprintId } })
    const marker = `collector-live-change-${randomUUID()}`
    definition.graph.nodes.push({ id: marker, kind: 'output' })
    writeFileSync(scene.definitionPath, JSON.stringify(definition), { mode: 0o600 })
    try {
      const live = await gateway.call('blueprint/loadDefinition', { args: { blueprintId: scene.blueprintId } })
      ensure(live.documentRevision && live.documentRevision !== liveBefore.documentRevision && live.semanticRevision !== liveBefore.semanticRevision, 'EVIDENCE_LIVE_DEFINITION_NOT_CHANGED')
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.locator(CONVERSATION_ROOT).waitFor({ state: 'visible', timeout: 15000 })
      const frozen = projectInspection(await inspect(targetSessionId), await page.evaluate(conversationDomProbe))
      ensure(identical(before, frozen) && !frozen.nodeIds.includes(marker), 'EVIDENCE_FROZEN_GRAPH_CONFUSED')
      add('frozen-graph', { before, after: frozen, changedNodeId: marker, liveDefinitionRevision: live.documentRevision,
        liveDefinitionBefore: liveBefore.documentRevision, liveSemanticBefore: liveBefore.semanticRevision, liveSemanticAfter: live.semanticRevision,
        definitionChanged: true }, await screenshot(page, reportDir, 'frozen-graph'))
    } finally { writeFileSync(scene.definitionPath, original, { mode: 0o600 }) }

    await view(scene.plainSessionId)
    const emptyCopies = [
      '当前对话暂无蓝图运行。可以新建或引用蓝图，保存方案后开始运行。',
      'This conversation has no blueprint runs. Create or use a blueprint, then run the saved plan.',
    ]
    const unavailableCopies = [
      '暂时无法加载实时蓝图，请稍后刷新。',
      'Unable to load the live blueprint right now. Try refreshing shortly.',
    ]
    const readEmptyState = () => page.locator(CONVERSATION_ROOT).evaluate(root => ({
      sessionId: root.getAttribute('data-bp-session'), connection: root.getAttribute('data-bp-connection'),
      runId: root.getAttribute('data-bp-run-id'),
      status: root.querySelector('[role="status"]')?.textContent,
      empty: root.querySelector('.bp-conversation-empty')?.textContent,
      nodes: root.querySelectorAll('[data-bp-node]').length,
    }))
    const neutralEmpty = value => value.sessionId === scene.plainSessionId && value.connection === 'connected'
      && emptyCopies.includes(value.empty) && !value.runId && value.nodes === 0
    const plainCopy = await poll(readEmptyState, neutralEmpty, 'EVIDENCE_PLAIN_EMPTY_COPY')
    const switches = [], plainMutationCount = native.mutations()
    for (let ordinal = 1; ordinal <= 10; ordinal++) {
      await selectTab(page, CHAT_TAB)
      await selectTab(page, BLUEPRINT_TAB)
      const firstFrame = await readEmptyState()
      ensure(['loading', 'connected'].includes(firstFrame.connection), 'EVIDENCE_PLAIN_REMOUNT_FALSE_ERROR')
      const settled = await poll(readEmptyState, neutralEmpty, 'EVIDENCE_PLAIN_REMOUNT_NOT_NEUTRAL')
      switches.push({ ordinal, firstConnection: firstFrame.connection, settledConnection: settled.connection })
    }
    const offline = {}
    try {
      await page.context().setOffline(true)
      offline.empty = await poll(readEmptyState, value => value.connection === 'unavailable'
        && unavailableCopies.includes(value.empty), 'EVIDENCE_PLAIN_OFFLINE_FALSE_EMPTY')
    } finally { await page.context().setOffline(false) }
    offline.emptyRecovered = await poll(readEmptyState, neutralEmpty, 'EVIDENCE_PLAIN_ONLINE_NOT_NEUTRAL')
    const plain = await page.evaluate(conversationDomProbe), plainHost = await inspect(scene.plainSessionId)
    ensure(plainHost.status === 'unbound' && plain.sessionId === scene.plainSessionId && !plain.runId && plain.nodes.length === 0 && plain.attempts.length === 0, 'EVIDENCE_PLAIN_SESSION_BOUND')
    ensure(native.mutations() === plainMutationCount, 'EVIDENCE_PLAIN_OBSERVATION_MUTATED')
    add('plain-unbound', { sessionId: scene.plainSessionId, sourceSessionId: scene.sessionId, hostStatus: plainHost.status,
      dom: plain, copy: plainCopy, switches, offline, mutationDelta: native.mutations() - plainMutationCount }, await screenshot(page, reportDir, 'plain-unbound'))
    if (mode === 'live') {
      const linked = await inspect(scene.sessionId)
      const source = linked.selected?.source
      const facts = readObserver()
      const calls = facts.sessions.find(item => item.sessionId === scene.sessionId)?.toolCalls ?? []
      const catalog = calls.find(item => item.name === 'blueprint_list' && item.ok && item.callLogged && item.resultLogged && item.pipelineResultObserved)
      const inspection = calls.find(item => item.name === 'blueprint_inspect' && item.ok && item.callLogged && item.resultLogged && item.pipelineResultObserved)
      ensure(source?.kind === 'tool' && source.sessionId === scene.sessionId && typeof source.turn === 'number' && source.callId
        && catalog && inspection && calls.some(item => item.name === 'blueprint_start' && item.callId === source.callId
          && item.ok && item.callLogged && item.resultLogged && item.pipelineResultObserved && item.turn === source.turn), 'EVIDENCE_NATIVE_TOOL_LINEAGE_MISSING')
      add('tool-lineage', { sessionId: source.sessionId, callId: source.callId, turn: source.turn, runId: linked.selected.run.runId,
        catalogCallId: catalog.callId, inspectCallId: inspection.callId,
        toolName: 'blueprint_start', nativeToolResultObserved: true }, await screenshot(page, reportDir, 'tool-lineage'))
      const run = linked.selected.run, model = run.attempts.find(item => item.sessionId === scene.executionSessionId)
      const downstream = run.attempts.find(item => item.nodeId === 'downstream')
      const payload = attempt => { try { return JSON.parse(attempt.outputJson)?.outputs?.payload } catch { return null } }
      const expected = JSON.parse(scene.inputJson), output = payload(model), downstreamOutput = payload(downstream)
      ensure(run.state === 'succeeded' && model?.nodeId === 'model' && model.state === 'succeeded' && model.resultKind === 'succeeded'
        && model.diagnostics?.acceptance?.code === 'accepted' && downstream?.state === 'succeeded' && downstream.resultKind === 'succeeded'
        && identical(output, expected) && identical(downstreamOutput, expected)
        && calls.find(item => item.callId === source.callId)?.inputSha256 === sha256(scene.inputJson)
        && facts.sessions.find(item => item.sessionId === model.sessionId)?.requests.length > 0, 'EVIDENCE_CHILD_ARTIFACT_MISMATCH')
      add('child-artifact', { runId: run.runId, sessionId: source.sessionId, sourceCallId: source.callId,
        executionSessionId: model.sessionId, attemptId: model.attemptId, downstreamAttemptId: downstream.attemptId,
        state: run.state, resultKind: model.resultKind, acceptanceCode: model.diagnostics.acceptance.code,
        inputSha256: sha256(scene.inputJson), outputSha256: sha256(JSON.stringify(output)), downstreamSha256: sha256(JSON.stringify(downstreamOutput)) },
      await screenshot(page, reportDir, 'child-artifact'))
    }
    // Restart follows quiescence, never cancellation or a fixture settlement.
    await poll(() => gateway.call('session/list', { _request: {} }), value => value.items.some(item => item.sessionId === scene.sessionId && !item.running), 'BROWSER_SOURCE_NOT_QUIESCENT', 30000)
    const restartBefore = projectInspection(await inspect(targetSessionId), await view(targetSessionId))
    const sourceBefore = await inspect(scene.sessionId), stateBefore = sourceBefore.selected.run.state
    ensure((mode === 'live' ? ['succeeded'] : ['waiting_input']).includes(stateBefore), 'EVIDENCE_RESTART_RUN_NOT_QUIESCENT')
    const originalObserver = readObserver()
    ensure(originalObserver.sessions.every(item => item.requests.every(request => !request.active) && item.approvals.every(approval => !approval.pending)), 'EVIDENCE_RESTART_ACTIVE_WORK')
    ensure(typeof restartHost === 'function', 'BROWSER_HOST_RESTART_REQUIRED')
    const mutationsBefore = native.mutations(), nativeStart = native.requests.length
    const restarted = await restartHost()
    ensure(restarted?.gateway && restarted.authUrl && restarted.observerFile, 'BROWSER_HOST_RESTART_INVALID')
    gateway = restarted.gateway
    await page.goto(restarted.authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
    ensure(new URL(page.url()).origin === gateway.origin, 'BROWSER_FOREIGN_ORIGIN')
    await page.waitForFunction(name => window.__DSH_BOOT__?.entries?.some(entry => (entry.id ?? entry.package) === name), receipt.package.name, { timeout: 15000 })
    const bundle = await page.evaluate(async name => {
      const entry = window.__DSH_BOOT__.entries.find(item => (item.id ?? item.package) === name)
      const response = await fetch(entry.url), text = await response.text()
      return { status: response.status, closure: text.includes('__ModuleLoader__.load') }
    }, receipt.package.name)
    ensure(bundle.status === 200 && bundle.closure, 'BROWSER_RESTART_CLIENT_BUNDLE_MISSING')
    receipt.restart.clientBundle = bundle
    const restartAfter = projectInspection(await inspect(targetSessionId), await view(targetSessionId)), sourceAfter = await inspect(scene.sessionId)
    receipt.restart.observer = publicObserverSnapshot(restarted.observerFile)
    receipt.restart.nativeRequests = native.requests.slice(nativeStart)
    receipt.restart.finishedAt = at()
    ensure(identical(restartBefore, restartAfter) && identical(sourceBefore, sourceAfter)
      && native.mutations() === mutationsBefore && receipt.restart.observer.sessions.every(item => item.requests.length === 0 && item.approvals.length === 0), 'EVIDENCE_HOST_RESTART_CHANGED')
    add('host-restart', { before: restartBefore, after: restartAfter, sourceBefore: sourceBefore.selected.source, sourceAfter: sourceAfter.selected.source,
      sourceSessionId: scene.sessionId, runStateBefore: stateBefore, runStateAfter: sourceAfter.selected.run.state,
      executionSessionEvidence: mode === 'live', mutationDelta: native.mutations() - mutationsBefore }, await screenshot(page, reportDir, 'host-restart'))
  } finally {
    receipt.nativeRequests = native.requests
    receipt.observer = readObserver()
    native.stop()
  }
}
