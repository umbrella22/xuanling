// Focused C-01/C-02/C-03 acceptance against an isolated real DSH and provider.
// Uses public admission, native DOM actions, and the passive AgentLoop observer.
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, ensure, sha256, auditArtifacts } from './conversation-evidence.mjs'
import { prepareProfile, bootHost, stopHost, makeGateway, isolatedEnvironment } from './conversation-runtime.mjs'
import { publicObserverSnapshot, observeNativeRequests, CONVERSATION_ROOT } from './conversation-browser.mjs'
import { openSession } from './conversation-fixture.mjs'
import { launchOwnedEdge } from './comfy-motion-ui.mjs'
import { captureEvidenceFingerprint } from '../../../integrations/deepseek-harness/xuanling-blueprint/scripts/verify.mjs'

const blueprintTab = /^(?:Blueprint|XuanLing Blueprint|蓝图|玄灵蓝图)$/i
const chatTab = /^(?:Chat|对话|聊天)$/i
const terminals = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_required'])
const at = () => new Date().toISOString()
async function poll(read, predicate, code, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(done => setTimeout(done, 50))
  }
  ensure(false, code)
}
async function selectTab(page, name) {
  const tab = page.locator('[data-conversation-tabs]').getByRole('tab', { name })
  await tab.waitFor({ state: 'visible' })
  await tab.click()
  await poll(() => tab.getAttribute('aria-selected'), value => value === 'true', 'BROWSER_TAB_NOT_SELECTED')
}
async function acknowledgePreview(page) {
  const preview = page.getByRole('dialog', { name: /^(?:预览版说明|Preview Notice)$/ })
  await preview.waitFor({ state: 'visible' })
  await preview.getByRole('button', { name: /^(?:继续|Continue)$/ }).click()
  await preview.waitFor({ state: 'hidden' })
}
const fixture = {
  async prepare({ root }) {
    const blueprints = {}
    for (const kind of ['parallel', 'failure']) {
      const id = `execution-sync-${kind}`, dir = join(root, id)
      mkdirSync(dir, { mode: 0o700 })
      writeFileSync(join(dir, 'worker.md'), 'Follow the instruction in the input JSON. Do not use tools.\n')
      const worker = name => ({ id: name, kind: 'agentTask', agentRef: 'worker', outputs: { value: 'string' } })
      const graph = kind === 'parallel' ? {
        nodes: [worker('a'), worker('b'), { id: 'merge', kind: 'join', join: 'all', inputs: { a: 'string', b: 'string' }, outputs: { a: 'string', b: 'string' } }],
        edges: [{ kind: 'data', from: 'a.value', to: 'merge.a' }, { kind: 'data', from: 'b.value', to: 'merge.b' }]
      } : { nodes: [{ ...worker('bad-output'), outputs: { value: 'json' } }], edges: [] }
      writeFileSync(join(dir, 'blueprint.json'), JSON.stringify({ schemaVersion: 1, id, name: id,
        resources: { worker: { kind: 'agent', path: 'worker.md' } }, graph }))
      blueprints[id] = dir
    }
    // First root turn is an explicit setup rejection. Subsequent root turns
    // and every Blueprint child use the actual provider without interception.
    const policy = join(root, 'seed-policy.mjs')
    writeFileSync(policy, `import {writeFileSync} from 'node:fs';
export const inject=['agents','llm'];
export function apply(ctx){const terminalFacts=[];
const streamFailures=[];ctx.on('llm/stream',async function*(options,next){for await(const chunk of next()){
if(chunk.type==='finish'&&chunk.reason?.failure){const text=String(chunk.reason.failure.message??'');
streamFailures.push({code:chunk.reason.failure.code,kind:chunk.reason.kind,bytes:text.length,
status:text.match(/\\b[45][0-9]{2}\\b/)?.[0]??null,
fields:['temperature','max_output_tokens','max_tokens','reasoning','tools','instructions','store','input','model','stream','connection','timeout','text','content','undefined','function','properties','json','schema','length','request','response','status','type','message','name','id','api key','token'].filter(name=>text.toLowerCase().includes(name)),
classifications:['unsupported','not supported','invalid','required','not found','rate limit','insufficient','ended without','empty','quota','unauthorized','cannot read','unexpected','not a function','missing','too many','too long','过载','限流','渠道','模型','令牌','超时','上游','未找到','无可用','负载','拒绝','网络','余额','配额','服务','重试','不支持','并发'].filter(name=>text.toLowerCase().includes(name))});
writeFileSync(${JSON.stringify(join(root, 'stream-failures.json'))},JSON.stringify(streamFailures),{mode:0o600});}yield chunk;}},{prepend:true});
ctx.on('session/event',(session,event)=>{if(event.type!=='turn/end')return;const reason=event.data.reason;
const message=typeof reason?.error?.message==='string'?reason.error.message:'';
terminalFacts.push({sessionId:session.id,kind:reason.kind,code:/^[A-Z0-9_-]{1,80}$/.test(reason?.error?.code??'')?reason.error.code:null,
status:message.match(/\\b[45][0-9]{2}\\b/)?.[0]??null,fields:['temperature','max_output_tokens','max_tokens','reasoning','tools','instructions','store','input','model','stream','connection','timeout'].filter(name=>message.toLowerCase().includes(name)),
classifications:['unsupported','not supported','invalid','required','not found','rate limit','insufficient','ended without','empty','quota','unauthorized'].filter(name=>message.toLowerCase().includes(name))});
writeFileSync(${JSON.stringify(join(root, 'terminal-facts.json'))},JSON.stringify(terminalFacts),{mode:0o600})});
const seen=new Set();ctx.on('agent/pre-step',async({agent},next)=>{
const decision=await next();if(agent.id.startsWith('execution-sync-source-')&&!seen.has(agent.id)){
seen.add(agent.id);return {kind:'reject'};}return decision;},{prepend:true})}\n`)
    return { blueprints, operatorModules: [policy] }
  }
}

export async function runExecutionSync(options) {
  ensure(!existsSync(options.reportDir), 'REPORT_ALREADY_EXISTS')
  mkdirSync(options.reportDir, { recursive: true, mode: 0o700 })
  const receipt = { planId: 'dsh-blueprint-execution-sync-v1', scenario: options.scenario ?? 'all', startedAt: at(), status: 'failed',
    fingerprint: captureEvidenceFingerprint(), provider: { model: options.providerModel, protocol: options.providerProtocol },
    cases: [], steps: [], rpc: [], pageErrors: 0, cleanup: {} }
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'bp-execution-sync-'))
  let host, edge, profile, page, native
  const add = (id, facts) => { receipt.cases.push({ id, at: at(), facts }); console.log(`PASS ${id}`) }
  const screenshot = async name => {
    const path = join(options.reportDir, `${name}.png`)
    await page.screenshot({ path, fullPage: false })
    return { path, sha256: sha256(readFileSync(path)) }
  }
  try {
    profile = await prepareProfile({ ...options, mode: 'live', installMode: 'linked' }, fixture, root, receipt.steps)
    host = bootHost(profile, receipt.steps)
    let authUrl = await host.ready, gateway = makeGateway(authUrl, receipt.rpc, 'live')
    await gateway.authenticate()
    ensure((await gateway.call('blueprint/ping', {})).status === 'ok', 'HOST_PLUGIN_NOT_MOUNTED')
    const require = createRequire(join(ROOT, 'test/blueprint/package.json'))
    const pw = await import(pathToFileURL(require.resolve('playwright')).href)
    edge = await launchOwnedEdge(pw.default ?? pw, isolatedEnvironment(profile.home), root)
    receipt.browser = edge.evidence
    page = await edge.context.newPage()
    await page.setViewportSize({ width: 1600, height: 1000 })
    page.setDefaultTimeout(15000)
    page.on('pageerror', () => receipt.pageErrors++)
    native = observeNativeRequests(page)
    await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await acknowledgePreview(page)
    await gateway.call('workspace/initializeDefault', {})
    const source = `execution-sync-source-${randomUUID()}`
    await gateway.call('session/create', { request: { sessionId: source, cwd: profile.cwd, agentPreset: 'standard' } })
    const prompt = async (sessionId, text) => gateway.call('session/prompt', { request: { sessionId,
      requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] } })
    const idle = sessionId => poll(() => gateway.call('session/list', { _request: {} }),
      value => value.items.some(item => item.sessionId === sessionId && !item.running && !item.blank), 'HOST_SESSION_NOT_IDLE', 120000)
    await prompt(source, 'Isolated setup turn: the policy will reject this before the model.')
    await idle(source)
    ensure(publicObserverSnapshot(profile.observerFile).sessions.every(s => s.requests.length === 0), 'PROVIDER_SETUP_CALL_UNEXPECTED')
    const inspect = runId => gateway.call('blueprint/inspectRun', { args: { runId } })
    const view = async sessionId => {
      await openSession({ page, gateway, sessionId })
      await selectTab(page, blueprintTab)
      await poll(() => page.locator(CONVERSATION_ROOT).getAttribute('data-bp-session'), v => v === sessionId, 'BROWSER_WRONG_BLUEPRINT_SESSION')
    }
    const start = async (kind, instruction) => {
      const blueprintId = `execution-sync-${kind}`
      const document = await gateway.call('blueprint/loadDefinition', { args: { blueprintId } })
      return gateway.call('blueprint/startSessionRun', { args: { blueprintId, sessionId: source,
        expectedRevision: document.documentRevision, requestId: randomUUID(), inputJson: JSON.stringify({ instruction }) } })
    }
    const childSelected = async (targetAddress) => {
      const label = (targetAddress.label ?? targetAddress.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const header = page.locator('header[data-window-drag]')
      await header.getByRole('button', { name: new RegExp(`^(?:Switch subagent: |切换子智能体：)${label}$`) }).waitFor({ state: 'visible' })
      await poll(() => page.locator('[data-conversation-tabs]').getByRole('tab', { name: chatTab }).getAttribute('aria-selected'), v => v === 'true', 'BROWSER_TARGET_CHAT_NOT_ACTIVE')
      const fresh = await gateway.call('session/projections', { request: { sessionId: source } })
      ensure(fresh.values.subagentCatalog.filter(item => (item.label ?? item.id) === (targetAddress.label ?? targetAddress.id)).length === 1, 'BROWSER_AMBIGUOUS_CHILD_LABEL')
      await header.locator('button[aria-haspopup="tree"]').click()
      const tree = page.getByRole('tree', { name: /^(?:Subagent sessions|子智能体会话)$/ })
      const current = tree.getByRole('treeitem', { name: new RegExp(`^${label}(?:\\s|$)`) })
      ensure(await current.count() === 1 && await current.getAttribute('aria-current') === 'true', 'BROWSER_CHILD_NOT_CURRENT')
      await page.keyboard.press('Escape')
      await tree.waitFor({ state: 'hidden' })
    }
    const runIds = []
    await openSession({ page, gateway, sessionId: source })
    const nonce = `bp-sync-${randomUUID()}`
    if (options.scenario !== 'failure') {
      const admitted = await start('parallel', `Begin your answer with ${nonce}. Then produce 80 numbered lines, each containing the words isolated parallel acceptance. Do not use tools.`)
      receipt.parallelRunId = admitted.runId
      runIds.push(admitted.runId)
      await selectTab(page, blueprintTab)
      const running = await poll(() => inspect(admitted.runId), value => ['a', 'b'].every(id => value.attempts.some(a => a.nodeId === id && a.sessionId && a.state === 'running')), 'PROVIDER_PARALLEL_ATTEMPTS_NOT_RUNNING')
      const a = running.attempts.find(a => a.nodeId === 'a'), b = running.attempts.find(a => a.nodeId === 'b')
      const catalog = await gateway.call('session/projections', { request: { sessionId: source } })
      const address = catalog.values.subagentCatalog.find(item => item.id === a.sessionId)
      ensure(address?.mode === 'one-shot', 'HOST_NATIVE_ADDRESS_MISSING')
      await page.locator(`${CONVERSATION_ROOT} [data-bp-node="a"]`).click()
      await childSelected(address)
      const afterClick = await inspect(admitted.runId)
      ensure(afterClick.attempts.find(item => item.attemptId === a.attemptId)?.state === 'running', 'BROWSER_BUSY_CLICK_MISSED_RUNNING_WINDOW')
      add('running-node-opens-native-chat', { sessionId: a.sessionId, attemptId: a.attemptId, state: 'running', screenshot: await screenshot('running-chat') })
      const settled = await poll(() => inspect(admitted.runId), value => terminals.has(value.state), 'PROVIDER_RUN_TIMEOUT', 120000)
      receipt.parallelSettlement = { runId: settled.runId, state: settled.state,
        attempts: settled.attempts.map(({ nodeId, attemptId, sessionId, state, resultKind, errorCode }) => ({ nodeId, attemptId, sessionId, state, resultKind, errorCode })) }
      ensure(settled.state === 'succeeded', 'PROVIDER_PARALLEL_RUN_FAILED')
      const facts = publicObserverSnapshot(profile.observerFile)
      const requests = [a, b].map(item => facts.sessions.find(session => session.sessionId === item.sessionId)?.requests)
      ensure(requests.every(items => items?.length === 1 && !items[0].failed && items[0].finishedAt), 'PROVIDER_REQUEST_COUNT_OR_FAILURE')
      const overlapMs = Math.min(...requests.map(items => Date.parse(items[0].finishedAt))) - Math.max(...requests.map(items => Date.parse(items[0].startedAt)))
      ensure(overlapMs > 0, 'PROVIDER_REQUESTS_SERIALIZED')
      for (const id of ['a', 'b']) ensure(settled.attempts.find(item => item.nodeId === id)?.outputJson?.includes(nonce), 'PROVIDER_OUTPUT_NONCE_MISSING')
      ensure(settled.attempts.find(item => item.nodeId === 'merge')?.outputJson?.includes(nonce), 'HOST_JOIN_OUTPUT_MISSING')
      add('real-provider-parallel-and-join', { overlapMs, requests: requests.flat(), state: settled.state, source: settled.source, outputsSha256: sha256(JSON.stringify(settled.attempts.map(a => a.outputJson))) })
      // Persist Blueprint as the child's chosen view, then navigate from the
      // source node. Native openSession must also request Chat in that target.
      await selectTab(page, blueprintTab)
      await view(source)
      const mutationBefore = native.mutations()
      await page.locator(`${CONVERSATION_ROOT} [data-bp-node="a"]`).click()
      await childSelected(address)
      add('completed-node-selects-chat-over-saved-blueprint', { sessionId: a.sessionId, mutationDelta: native.mutations() - mutationBefore, screenshot: await screenshot('completed-chat') })
      ensure(native.mutations() === mutationBefore, 'BROWSER_NAVIGATION_MUTATED_RUN')
      await selectTab(page, blueprintTab)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await poll(() => page.locator(CONVERSATION_ROOT).getAttribute('data-bp-session'), v => v === a.sessionId, 'BROWSER_MANUAL_BLUEPRINT_NOT_PRESERVED')
      add('manual-blueprint-selection-survives-reload', { sessionId: a.sessionId, screenshot: await screenshot('manual-blueprint') })
      await view(source)
    }
    const failedAdmission = await start('failure', `Reply exactly with the unquoted plain text: NON_JSON_${nonce}. Do not use tools.`)
    runIds.push(failedAdmission.runId)
    const failed = await poll(() => inspect(failedAdmission.runId), value => terminals.has(value.state), 'PROVIDER_FAILURE_SCENE_TIMEOUT', 120000)
    // Both an actual provider failure and the intended invalid JSON exercise
    // the same immutable failed-Attempt navigation contract. Record which
    // occurred; neither is accepted as model success or output validation.
    receipt.failureSettlement = { state: failed.state, attempts: failed.attempts.map(({ nodeId, sessionId, state, resultKind, errorCode }) => ({ nodeId, sessionId, state, resultKind, errorCode })) }
    ensure(failed.state === 'failed' && ['output-invalid', 'provider-failed'].includes(failed.attempts[0]?.resultKind), 'HOST_FAILED_ATTEMPT_MISSING')
    const bad = failed.attempts[0]
    await view(source)
    await page.locator(`[data-bp-attempt-id="${bad.attemptId}"]`).click()
    await page.locator(`[data-bp-failure-explanation="${bad.attemptId}"]`).waitFor({ state: 'visible' })
    const failureImage = await screenshot('failed-explanation')
    await page.locator(`[data-bp-open-attempt="${bad.attemptId}"]`).click()
    const failedCatalog = await gateway.call('session/projections', { request: { sessionId: source } })
    const failedAddress = failedCatalog.values.subagentCatalog.find(item => item.id === bad.sessionId)
    ensure(failedAddress?.mode === 'one-shot', 'HOST_FAILED_NATIVE_ADDRESS_MISSING')
    await childSelected(failedAddress)
    await selectTab(page, blueprintTab)
    await poll(() => page.locator(CONVERSATION_ROOT).getAttribute('data-bp-session'), v => v === bad.sessionId, 'BROWSER_FAILED_CHILD_NOT_SELECTED')
    await page.locator(`[data-bp-attempt-id="${bad.attemptId}"]`).click()
    await page.locator(`[data-bp-source-chat="${source}"]`).click()
    await poll(() => page.locator('[data-conversation-tabs]').getByRole('tab', { name: chatTab }).getAttribute('aria-selected'), v => v === 'true', 'BROWSER_SOURCE_CHAT_NOT_SELECTED')
    ensure(await page.locator(`[data-row-key="session:${source}"]`).getAttribute('aria-selected') === 'true', 'BROWSER_SOURCE_SESSION_NOT_SELECTED')
    await selectTab(page, blueprintTab)
    await poll(() => page.locator(CONVERSATION_ROOT).getAttribute('data-bp-session'), v => v === source, 'BROWSER_SOURCE_BLUEPRINT_NOT_SELECTED')
    await selectTab(page, chatTab)
    add('failed-history-and-source-chat', { runId: failed.runId, sessionId: bad.sessionId, fault: bad.resultKind, sourceSessionId: source, screenshot: failureImage })
    const beforeMain = sha256(JSON.stringify(await inspect(failedAdmission.runId)))
    await prompt(source, `Reply exactly: main continued ${nonce}. Do not use tools.`)
    await idle(source)
    ensure(sha256(JSON.stringify(await inspect(failedAdmission.runId))) === beforeMain, 'HOST_FAILED_HISTORY_CHANGED_BY_MAIN')
    const continued = publicObserverSnapshot(profile.observerFile).sessions.find(s => s.sessionId === source)
    ensure(continued.requests.length === 1, 'PROVIDER_MAIN_CONTINUATION_REQUEST_MISSING')
    const mainSucceeded = continued.requests[0].textDeltas > 0 && !continued.requests[0].failed && !continued.runtimeError
    receipt.mainContinuationSucceeded = mainSucceeded
    add('failed-history-unchanged-after-main-turn', { runId: failed.runId, mainSucceeded, failedHistoryUnchanged: true })
    receipt.observer = publicObserverSnapshot(profile.observerFile)
    const beforeRestart = await Promise.all(runIds.map(inspect))
    await stopHost(host.child)
    const observerFile = join(root, 'observer-restart-facts.json')
    profile = { ...profile, observerFile, env: { ...profile.env, BP_CONVERSATION_OBSERVER_FILE: observerFile } }
    host = bootHost(profile, receipt.steps, 'boot-2')
    authUrl = await host.ready
    gateway = makeGateway(authUrl, receipt.rpc, 'live', 2)
    await gateway.authenticate()
    await page.goto(authUrl, { waitUntil: 'domcontentloaded' })
    // The same native profile retains its preview acknowledgement. The shared
    // navigation helper dismisses it if this Host does present it again.
    ensure(sha256(JSON.stringify(await Promise.all(runIds.map(inspect)))) === sha256(JSON.stringify(beforeRestart)), 'HOST_RESTART_RUN_FACTS_CHANGED')
    await view(source)
    await page.locator(`[data-bp-open-attempt="${bad.attemptId}"]`).click()
    await childSelected(failedAddress)
    receipt.restartObserver = publicObserverSnapshot(observerFile)
    ensure(receipt.restartObserver.sessions.every(s => s.requests.length === 0), 'HOST_RESTART_REDISPATCHED_MODEL')
    add('cold-restart-history-navigation', { sameProfile: true, noModelRedispatch: true, durableFactsUnchanged: true, screenshot: await screenshot('restart-chat') })
    ensure(receipt.pageErrors === 0, 'BROWSER_PAGE_ERROR')
    receipt.status = mainSucceeded ? 'passed' : 'failed'
    if (!mainSucceeded) receipt.failure = 'PROVIDER_MAIN_CONTINUATION_MISSING'
  } catch (error) {
    receipt.failure = typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'EXECUTION_SYNC_OPERATION_FAILED'
    receipt.failureType = typeof error?.name === 'string' ? error.name : 'Error'
    if (typeof error?.message === 'string') {
      const code = error.message.match(/\b(?:BROWSER|HOST|PROVIDER|FIXTURE|EVIDENCE|REPORT|EXECUTION)_[A-Z0-9_]+\b/)?.[0]
      if (code) receipt.failure = code
    }
    receipt.failureLocations = String(error?.stack ?? '').split('\n').filter(line => /\bat .*(?:execution-sync-ui|conversation-fixture|conversation-browser)\.mjs:\d+:\d+/.test(line)).map(line => line.trim())
    if (page) { try { receipt.failureScreenshot = await screenshot('failure'); receipt.visibleTabs = await page.locator('[data-conversation-tabs] [role="tab"]').allTextContents() } catch {} }
    if (profile && existsSync(profile.observerFile)) receipt.observer = publicObserverSnapshot(profile.observerFile)
    console.log(`FAIL ${receipt.failure}`)
  } finally {
    if (existsSync(join(root, 'terminal-facts.json'))) receipt.terminalFacts = JSON.parse(readFileSync(join(root, 'terminal-facts.json'), 'utf8'))
    if (existsSync(join(root, 'stream-failures.json'))) receipt.streamFailures = JSON.parse(readFileSync(join(root, 'stream-failures.json'), 'utf8'))
    native?.stop()
    try { if (edge) await edge.close(); receipt.cleanup.browserClosed = true } catch { receipt.cleanup.browserClosed = false }
    try { if (host) await stopHost(host.child); receipt.cleanup.hostStopped = true } catch { receipt.cleanup.hostStopped = false }
    rmSync(root, { recursive: true, force: true })
    receipt.cleanup.isolationRemoved = !existsSync(root)
    receipt.finishedAt = at()
    receipt.fingerprintAfter = captureEvidenceFingerprint()
    receipt.sourceUnchanged = ['revision', 'source_sha256', 'artifact_sha256'].every(key => receipt.fingerprint[key] === receipt.fingerprintAfter[key])
    if (!Object.values(receipt.cleanup).every(Boolean) || !receipt.sourceUnchanged) receipt.status = 'failed'
    writeFileSync(join(options.reportDir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
    const leaks = auditArtifacts(options.reportDir)
    ensure(leaks.length === 0, 'SECRET_REPORT_AUDIT_FAILED')
  }
  return { status: receipt.status, failure: receipt.failure, cases: receipt.cases.length, reportDir: options.reportDir }
}
