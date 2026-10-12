// Actual isolated CLI installation, public gateway, native Edge and provider.
// Operator modules arrange inputs; public events and physical bytes supply facts.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { chromium } from 'playwright'
import { ROOT, ensure, sha256, assertPhysicalPath, auditArtifacts } from './conversation-evidence.mjs'
import { prepareProfile, bootHost, stopHost, APPROVAL_FILE_CONTENT, isolatedEnvironment } from './conversation-runtime.mjs'
import { launchOwnedEdge } from './comfy-motion-ui.mjs'
import { COMPOSER, observeNativeRequests, publicObserverSnapshot, streamObservation, approvalObservation,
  approvalSettlementObservation, conversationDomProbe, conversationDomReadyForSession, projectInspection } from './conversation-browser.mjs'
import { prepareLiveTeamFixture, safeGateway, safeOperatorFacts, safeReadJson, extractProviderKey,
  artifactAudit, validateMemberLineage, safeCode, safeRun } from './teamstage-live-collector.mjs'
import { verifyLatestDshTuple, installedDshInventory, validateInstalledDshTuple } from './teamstage-version.mjs'
import { captureEvidenceFingerprint } from '../../../integrations/deepseek-harness/xuanling-blueprint/scripts/verify.mjs'
import { validateTeamStageBrowserReceipt } from '../../../integrations/deepseek-harness/xuanling-blueprint/test/browser/teamstage-browser.mjs'

const LEAD = 'live-teamstage-lead', BLUEPRINT = 'live-teamstage'
const TEAM_PROFILE = '@deepseek-ai/dsh-experimental-agent-team-profile'
const CHAT = /^(?:Chat|对话|聊天)$/i, BLUEPRINT_TAB = /^(?:Blueprint|XuanLing Blueprint|蓝图|玄灵蓝图)$/i
const TERMINALS = ['succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_required']

async function poll(read, predicate, code, timeout = 15000) {
  const start = Date.now()
  while (timeout === null || Date.now() - start < timeout) {
    const value = await read()
    if (predicate(value)) return value
    await pause(50)
  }
  ensure(false, code)
}
async function tab(page, name) {
  const target = page.getByRole('tab', { name })
  ensure(await target.count() === 1, 'BROWSER_NATIVE_TAB_MISSING')
  await target.click()
  ensure(await target.getAttribute('aria-selected') === 'true', 'BROWSER_NATIVE_TAB_NOT_SELECTED')
}
async function image(page, report, name) {
  const path = join(report, `${name}.png`)
  await page.screenshot({ path, fullPage: false, timeout: 15000 })
  return { path: `${name}.png`, sha256: sha256(readFileSync(path)), at: new Date().toISOString() }
}
function teamDomProbe() {
  const team = document.querySelector('[data-bp-team-stage]')
  if (!team) return null
  const task = team.querySelector('[data-bp-team-task-id]')
  return { stageId: team.getAttribute('data-bp-team-stage'), runId: team.getAttribute('data-bp-team-run'),
    state: team.getAttribute('data-bp-team-state'), taskId: task?.getAttribute('data-bp-team-task-id') ?? null,
    taskRevision: task ? Number(task.getAttribute('data-bp-team-task-revision')) : null,
    members: [...team.querySelectorAll('[data-bp-member-id]')].map(member => ({ memberId: member.getAttribute('data-bp-member-id'),
      sessionId: member.getAttribute('data-bp-member-session'), phase: member.getAttribute('data-bp-member-phase'),
      status: member.getAttribute('data-bp-member-status'), activity: member.getAttribute('data-bp-activity') })),
    acceptance: team.querySelector('[data-bp-team-acceptance]')?.getAttribute('data-bp-team-acceptance') ?? null,
    controls: team.querySelectorAll('button,textarea,[contenteditable="true"]').length }
}
function policySource(mode) {
  return `export const inject=['agents','tools'];
export function apply(ctx){
${mode === 'keyless' ? "ctx.on('agent/pre-step',async ({agent},next)=>{const decision=await next();return agent.id==='live-teamstage-lead'?{kind:'reject'}:decision},{prepend:true});" : ''}
ctx.on('tools/pre-execute',async(exec,next)=>{const decision=await next();
if(decision.kind!=='allow'||exec.name!=='write'||exec.agent?.id!=='live-teamstage-lead'||exec.arguments.file_path!=='native-approval.txt')return decision;
return {kind:'ask',reason:'Explicit isolated TeamStage acceptance file write',displayReason:{en:'Allow the isolated fixture file write once.',zh:'允许隔离场景文件写入一次。'}};},{prepend:true});
}`
}
function argumentsOf(args) {
  const values = {}
  for (let i = 0; i < args.length; i += 2) {
    ensure(args[i]?.startsWith('--') && args[i + 1] && !args[i + 1].startsWith('--'), 'COLLECTOR_ARGUMENT_INVALID')
    ensure(values[args[i].slice(2)] === undefined, 'COLLECTOR_ARGUMENT_INVALID')
    values[args[i].slice(2)] = args[i + 1]
  }
  ensure(['keyless', 'live'].includes(values.mode), 'COLLECTOR_MODE_INVALID')
  for (const key of ['report-dir', 'version-receipt', 'pnpm-executable']) ensure(values[key] && resolve(values[key]) === values[key], 'COLLECTOR_PATH_INVALID')
  if (values.mode === 'live') for (const key of ['provider', 'model', 'protocol', 'base-url', 'key-file']) ensure(values[key], 'COLLECTOR_LIVE_CONFIGURATION_MISSING')
  return values
}

async function main() {
  const options = argumentsOf(process.argv.slice(2)), report = options['report-dir']
  ensure(report.startsWith(join(ROOT, 'docs/validation/blueprint/current/teamstage') + '/') && !existsSync(report), 'COLLECTOR_REPORT_INVALID')
  assertPhysicalPath(report); mkdirSync(report, { recursive: true, mode: 0o700 })
  const receipt = { schema_version: 1, plan_id: 'dsh-blueprint-teamstage-v1', work_package: 'W3.3-W3.4', mode: options.mode,
    started_at: new Date().toISOString(), status: 'running', fingerprint_before: captureEvidenceFingerprint(),
    key_read: false, provider_calls: 0, steps: [], rpc: [], cases: [], navigation_requests: [], page_errors: [], screenshots: [] }
  let root, child, edge, native, profile, paths, run, page
  const save = () => writeFileSync(join(report, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  const phase = name => { receipt.phase = name; save(); console.log(JSON.stringify({ phase: name, provider_calls: receipt.provider_calls })) }
  try {
    phase('latest-version')
    const tuple = await verifyLatestDshTuple(options['version-receipt'], report)
    receipt.resolved_dsh_tuple = tuple
    root = mkdtempSync(join(realpathSync(tmpdir()), 'teamstage-native-browser-'))
    paths = { ready: join(root, 'lead-ready.json'), operatorFacts: join(root, 'operator-facts.json') }
    const config = { provider: options.provider ?? 'none', model: options.model ?? 'keyless', protocol: options.protocol ?? 'none', baseUrl: options['base-url'], leadAgentPreset: 'standard' }
    let isolatedKey
    if (options.mode === 'live') {
      const key = extractProviderKey(options['key-file'], config.provider)
      isolatedKey = join(root, 'provider-key.txt'); writeFileSync(isolatedKey, key, { flag: 'wx', mode: 0o600 }); receipt.key_read = true
    }
    phase('cli-pack-install')
    profile = await prepareProfile({ mode: options.mode, installMode: 'cli', pnpmExecutable: options['pnpm-executable'], keyFile: isolatedKey,
      providerModel: config.model, providerProtocol: config.protocol, providerBaseUrl: config.baseUrl },
    { prepare: async () => {
      const fixture = prepareLiveTeamFixture(root, paths, config), policy = join(root, 'teamstage-acceptance-policy.mjs')
      writeFileSync(policy, policySource(options.mode), { flag: 'wx', mode: 0o600 })
      fixture.operatorModules.push(policy)
      return fixture
    } }, root, receipt.steps)
    const manifestPath = join(profile.profileDir, 'package.json'), manifest = JSON.parse(readFileSync(manifestPath))
    manifest.dsh.profile.bundles.push(TEAM_PROFILE); writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 })
    const profilePackages = installedDshInventory(profile.profileDir)
    // The official profile disables autoInstallPeers. DSH peer packages are
    // provided by the CLI installation's public package resolver.
    const installed = installedDshInventory(join(ROOT, 'test/blueprint'))
    validateInstalledDshTuple(tuple, installed)
    if (profilePackages.length) validateInstalledDshTuple(tuple, profilePackages)
    receipt.installation = { mode: 'cli', profile: profile.profile, isolated: true, manifest_sha256: sha256(readFileSync(manifestPath)),
      dsh_version: tuple.packages['@deepseek-ai/dsh'].version, team_profile: TEAM_PROFILE, packages: installed,
      profile_packages: profilePackages, peer_resolution: 'official DSH CLI runtime; autoInstallPeers=false', artifacts: profile.installedInventory }
    profile.env.XUANLING_TEAMSTAGE_COLLECTOR_OBSERVE_ONLY = '0'
    phase('boot-native-host')
    const boot = bootHost(profile, receipt.steps); child = boot.child
    let authUrl = await boot.ready, gateway = safeGateway(authUrl, receipt.rpc, 1)
    gateway.origin = new URL(authUrl).origin
    await gateway.authenticate()
    const ready = await poll(() => safeReadJson(paths.ready), value => value?.instance_pid === child.pid && value.operator_ready && !value.observation_only, 'HOST_OPERATOR_NOT_READY', 30000)
    ensure(ready.lead_preset === 'standard' && ready.lead_tool_names.includes('write') && ready.lead_tool_names.includes('team_task_list'), 'HOST_LEAD_TOOL_UNAVAILABLE')
    receipt.lead_composition = { preset: ready.lead_preset, tool_names: ready.lead_tool_names }
    assert.equal((await gateway.call('blueprint/ping', {})).status, 'ok')
    await gateway.call('workspace/initializeDefault', {})
    const prompt = async (text, sessionId = LEAD) => {
      const response = await gateway.call('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] } })
      ensure(response.accepted === true, 'PROVIDER_PROMPT_NOT_ACCEPTED')
    }
    const readObserver = () => publicObserverSnapshot(profile.observerFile)
    const readOperator = () => safeOperatorFacts(safeReadJson(paths.operatorFacts))
    const idle = async (sessionId = LEAD) => poll(async () => ({ list: await gateway.call('session/list', { _request: {} }), operator: readOperator() }), value => {
      ensure(value.operator.failed_provider_calls === 0, 'PROVIDER_REQUEST_FAILED')
      return value.list.items.some(item => item.sessionId === sessionId && !item.running && !item.blank)
        && value.operator.stream_requests.every(request => request.finished)
    }, 'PROVIDER_NOT_QUIESCENT', null)
    await prompt(options.mode === 'live' ? 'Reply exactly "TeamStage acceptance ready". Do not call tools.' : 'Isolated keyless navigation seed. Reject this turn before any model request.')
    if (options.mode === 'live') await idle()
    phase('native-edge-readiness')
    edge = await launchOwnedEdge({ chromium }, isolatedEnvironment(profile.home), root)
    page = edge.context.pages()[0] ?? await edge.context.newPage()
    await page.setViewportSize({ width: 1440, height: 1100 })
    page.on('pageerror', () => receipt.page_errors.push({ code: 'BROWSER_PAGE_ERROR', at: new Date().toISOString() }))
    native = observeNativeRequests(page)
    await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
    const acknowledgeWelcome = async (required = false) => {
      receipt.navigation_step = 'native-welcome'
      const preview = page.getByRole('dialog', { name: /^(?:预览版说明|Preview Notice)$/ })
      if (required) await preview.waitFor({ state: 'visible', timeout: 15000 })
      else {
        // The native welcome acknowledgement is durable in this profile.
        // Wait for the hydrated sidebar; a same-profile restart may omit it.
        await page.locator('[data-row-key^="workspace:"][role="treeitem"]').first().waitFor({ state: 'visible', timeout: 15000 })
        if (!await preview.isVisible()) return
      }
      await preview.getByRole('button', { name: /^(?:继续|Continue)$/ }).click()
      await preview.waitFor({ state: 'hidden', timeout: 15000 })
    }
    await acknowledgeWelcome(true)
    const inspect = sessionId => gateway.call('blueprint/inspectSession', { args: { sessionId } })
    const openRoot = async sessionId => {
      receipt.navigation_step = 'native-sidebar-root'
      await page.locator('[data-row-key^="workspace:"][role="treeitem"]').first().waitFor({ state: 'visible', timeout: 15000 })
      const preview = page.getByRole('dialog', { name: /^(?:预览版说明|Preview Notice)$/ })
      if (await preview.isVisible()) { await preview.getByRole('button', { name: /^(?:继续|Continue)$/ }).click(); await preview.waitFor({ state: 'hidden' }) }
      const target = page.locator(`[data-row-key="session:${sessionId}"][role="treeitem"]`)
      if (!await target.isVisible()) {
        const groups = page.locator('[data-row-key^="workspace:"][role="treeitem"][aria-expanded="false"]')
        while (await groups.count()) await groups.first().click()
      }
      await target.waitFor({ state: 'visible', timeout: 15000 }); ensure(await target.count() === 1, 'BROWSER_SESSION_ROW_AMBIGUOUS')
      await target.click(); ensure(await target.getAttribute('aria-selected') === 'true', 'BROWSER_SESSION_NOT_SELECTED')
    }
    const openNative = async sessionId => {
      const sessions = await gateway.call('session/list', { _request: {} }), item = sessions.items.find(item => item.sessionId === sessionId)
      ensure(item, 'BROWSER_SESSION_NOT_FOUND')
      if (item.origin !== 'subagent') return openRoot(sessionId)
      const member = run?.team.members.find(member => member.sessionId === sessionId)
      ensure(member && item.parentSessionId === LEAD, 'BROWSER_CANONICAL_MEMBER_UNAVAILABLE')
      await openRoot(LEAD); await page.locator('[data-team-action] button').click()
      const target = page.locator('[data-team-panel]').getByRole('button').filter({ hasText: member.name })
      ensure(await target.count() === 1, 'NATIVE_TEAM_MEMBER_BUTTON_MISSING'); await target.click(); await page.keyboard.press('Escape')
    }
    const view = async sessionId => {
      const start = native.requests.length
      await openNative(sessionId); await tab(page, BLUEPRINT_TAB)
      const value = await inspect(sessionId)
      const dom = await poll(() => page.evaluate(conversationDomProbe), dom => conversationDomReadyForSession(dom, sessionId, value), 'BROWSER_RUN_IDENTITY_MISMATCH')
      receipt.navigation_requests.push(...native.requests.slice(start))
      ensure(dom.nestedComposers === 0, 'BROWSER_SECOND_COMPOSER')
      return { value, dom }
    }
    await view(LEAD)
    await page.locator('[data-team-action] button').click()
    await page.locator('[data-team-panel][role="dialog"]').waitFor({ state: 'visible', timeout: 15000 })
    receipt.cases.push({ id: 'latest-native-team-entry', entry: 'conversation-header action', mounted: true })
    receipt.screenshots.push(await image(page, report, 'native-team-entry'))
    await page.keyboard.press('Escape')
    if (options.mode === 'keyless') {
      ensure(readOperator().provider_calls === 0, 'PROVIDER_KEYLESS_REQUEST_OBSERVED')
      const restarts = []
      for (let repeat = 1; repeat <= 3; repeat++) {
        const previousPid = child.pid
        await stopHost(child); child = undefined; profile.env.XUANLING_TEAMSTAGE_COLLECTOR_OBSERVE_ONLY = '1'
        const restarted = bootHost(profile, receipt.steps, `keyless-restart-${repeat}`); child = restarted.child; authUrl = await restarted.ready
        gateway = safeGateway(authUrl, receipt.rpc, repeat + 1); gateway.origin = new URL(authUrl).origin; await gateway.authenticate()
        await poll(() => safeReadJson(paths.ready), value => value?.instance_pid === child.pid && value.operator_ready && value.observation_only, 'HOST_RESTART_OBSERVER_NOT_READY', 30000)
        await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); await acknowledgeWelcome(); await view(LEAD)
        const observed = readOperator()
        ensure(child.pid !== previousPid && observed.provider_calls === 0 && observed.events.length === 0
          && observed.sessions.every(session => session.requests.length === 0 && session.tools.length === 0), 'HOST_RESTART_REDISPATCH')
        restarts.push({ repeat, before_pid: previousPid, after_pid: child.pid, provider_calls: 0, tool_calls: 0 })
      }
      receipt.keyless_restarts = restarts
      receipt.status = 'passed'; receipt.scope = 'CLI install/native Team header entry/browser readiness/same-profile restart3; live not_run'
    } else {
      phase('automatic-teamstage')
      const doc = await gateway.call('blueprint/loadDefinition', { args: { blueprintId: BLUEPRINT } })
      const args = { sessionId: LEAD, blueprintId: BLUEPRINT, expectedRevision: doc.documentRevision,
        requestId: 'teamstage-native-browser-run', inputJson: JSON.stringify({ request: 'Perform the live TeamStage acceptance task.' }) }
      const started = await gateway.call('blueprint/startSessionRun', { args })
      const replay = await gateway.call('blueprint/startSessionRun', { args })
      assert.equal(replay.runId, started.runId); assert.equal(replay.replayed, true)
      await poll(async () => gateway.call('blueprint/inspectRun', { args: { runId: started.runId } }), snapshot => {
        run = snapshot
        receipt.run = safeRun(snapshot); receipt.provider_calls = readOperator().provider_calls; save()
        return snapshot.team?.members.some(member => member.sessionId) || TERMINALS.includes(snapshot.state)
      }, 'TEAMSTAGE_MEMBER_NOT_BOUND', null)
      await view(LEAD)
      const active = await poll(() => page.evaluate(teamDomProbe), value => value?.runId === run.runId && value.members.length > 0, 'BROWSER_TEAM_PROJECTION_MISSING')
      ensure(active.controls === 0, 'BROWSER_TEAM_EXECUTION_CONTROL')
      receipt.cases.push({ id: 'active-teamstage', dom: active }); receipt.screenshots.push(await image(page, report, 'active-teamstage'))
      run = await poll(async () => gateway.call('blueprint/inspectRun', { args: { runId: started.runId } }), snapshot => {
        receipt.run = safeRun(snapshot); receipt.provider_calls = readOperator().provider_calls; save()
        return TERMINALS.includes(snapshot.state)
      }, 'TEAMSTAGE_NOT_TERMINAL', null)
      ensure(run.state === 'succeeded' && run.team?.state === 'succeeded', 'LIVE_TEAM_RUN_NOT_SUCCEEDED')
      await idle()
      const operator = readOperator()
      receipt.artifact_audit = artifactAudit(root, run)
      receipt.member_lineage = validateMemberLineage(run, operator, config, receipt.artifact_audit)
      receipt.team_operator = operator
      const member = run.team.members[0]
      await view(LEAD)
      const terminalDom = await poll(() => page.evaluate(teamDomProbe), value => value?.state === 'succeeded' && value.acceptance === 'accepted', 'BROWSER_ACCEPTANCE_MISSING')
      assert.equal(terminalDom.taskId, run.team.taskId); assert.equal(terminalDom.taskRevision, run.team.taskRevision)
      assert.equal(terminalDom.members[0].sessionId, member.sessionId); assert.equal(terminalDom.members[0].phase, member.phase); assert.equal(terminalDom.members[0].status, member.status)
      await page.locator('[data-bp-team-acceptance] summary').click()
      const evidenceText = await page.locator('[data-bp-team-acceptance]').innerText()
      for (const value of [run.team.outputAcceptance.artifactId, run.team.outputAcceptance.digest, member.sessionId]) ensure(evidenceText.includes(value), 'BROWSER_ARTIFACT_FACT_MISSING')
      await page.locator('[data-bp-team-acceptance]').getByText(run.team.outputAcceptance.digest, { exact: true }).scrollIntoViewIfNeeded()
      receipt.cases.push({ id: 'accepted-teamstage', dom: terminalDom }); receipt.screenshots.push(await image(page, report, 'accepted-teamstage'))
      // Public native projection and the actual native Team member button.
      const projection = await gateway.call('session/projections', { request: { sessionId: LEAD } })
      const team = projection.values.agentTeam
      receipt.native_team_projection = { selector_session_id: LEAD,
        members: team.members.map(row => ({ id: row.id, role: row.role, phase: row.phase })),
        tasks: team.tasks.map(task => ({ id: task.id, revision: task.revision, status: task.status })) }
      // TeamProjection is the public wire view; TeamId belongs to its Session
      // selector and canonical binding. The wire schema has no id/teamId field.
      ensure(run.team.teamId === LEAD && team.members.some(row => row.id === LEAD && row.role === 'lead')
        && team.members.some(row => row.id === member.sessionId && row.role === 'teammate')
        && team.tasks.some(task => task.id === run.team.taskId && task.revision === run.team.taskRevision && task.status === 'completed'), 'NATIVE_TEAM_PROJECTION_MISMATCH')
      const requestStart = native.requests.length
      await page.locator('[data-team-action] button').click()
      const panel = page.locator('[data-team-panel]')
      ensure((await panel.innerText()).includes(run.team.taskId), 'NATIVE_TEAM_TASK_NOT_RENDERED')
      const memberButton = panel.getByRole('button').filter({ hasText: member.name })
      ensure(await memberButton.count() === 1, 'NATIVE_TEAM_MEMBER_BUTTON_MISSING')
      await memberButton.click(); await page.keyboard.press('Escape'); await tab(page, BLUEPRINT_TAB)
      const memberInspect = await inspect(member.sessionId)
      const memberDom = await poll(() => page.evaluate(conversationDomProbe), dom => conversationDomReadyForSession(dom, member.sessionId, memberInspect), 'BROWSER_NATIVE_MEMBER_RUN_MISSING')
      assert.deepEqual(memberInspect.selected.focusAttemptIds, [run.team.attemptId])
      receipt.navigation_requests.push(...native.requests.slice(requestStart))
      receipt.cases.push({ id: 'native-member-open', dom: memberDom, focusAttemptIds: memberInspect.selected.focusAttemptIds }); receipt.screenshots.push(await image(page, report, 'native-member-run'))
      await view(LEAD); await tab(page, CHAT)
      const composer = page.locator(COMPOSER), draft = `teamstage-draft-${randomUUID()}`
      ensure(await composer.count() === 1, 'BROWSER_NATIVE_COMPOSER_MISSING'); await composer.fill(draft)
      const digest = sha256(draft), navDraft = native.requests.length
      await tab(page, BLUEPRINT_TAB); assert.equal(sha256(await composer.innerText()), digest)
      await tab(page, CHAT); await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
      await poll(async () => sha256(await composer.innerText()), value => value === digest, 'BROWSER_DRAFT_NOT_RESTORED')
      receipt.navigation_requests.push(...native.requests.slice(navDraft)); receipt.cases.push({ id: 'draft-switch-reload', sha256: digest, composerCount: await composer.count() })
      await composer.fill('')
      phase('live-stream-switch')
      await tab(page, BLUEPRINT_TAB)
      await prompt('Do not call tools. Begin output immediately with line 1 and continue with 200 numbered lines in the exact form "streaming fixture line N" until the response token budget is exhausted. Do not plan, explain, or ask for confirmation before line 1.')
      await poll(() => streamObservation(readObserver(), LEAD), value => { ensure(!value.failed, 'PROVIDER_STREAM_FAILED'); return value.active && value.textDeltas > 0 }, 'PROVIDER_STREAM_NOT_OBSERVED', null)
      const switches = [], navStream = native.requests.length
      for (let i = 0; i < 10; i++) {
        const before = streamObservation(readObserver(), LEAD), mutations = native.mutations()
        await tab(page, CHAT); await tab(page, BLUEPRINT_TAB)
        const after = streamObservation(readObserver(), LEAD)
        ensure(before.active && after.active && !before.failed && !after.failed, 'BROWSER_STREAM_ENDED_DURING_SWITCH')
        assert.deepEqual(after.identities, before.identities); assert.equal(after.requestIdentity, before.requestIdentity)
        ensure(native.mutations() === mutations, 'BROWSER_STREAM_MUTATION')
        switches.push({ ordinal: i + 1, before, after, mutationDelta: native.mutations() - mutations })
      }
      receipt.navigation_requests.push(...native.requests.slice(navStream)); receipt.cases.push({ id: 'stream-switch-10', switches })
      receipt.screenshots.push(await image(page, report, 'stream-switch-10')); await idle()
      phase('native-write-approval')
      ensure(readOperator().sessions.find(session => session.sessionId === LEAD)?.requests.at(-1)?.tool_names.includes('write'), 'PROVIDER_WRITE_NOT_EXPOSED')
      const turnsBeforeApproval = readOperator().sessions.find(session => session.sessionId === LEAD)?.terminals.length ?? 0
      await prompt(`Call the native write tool exactly once with these exact JSON arguments: ${JSON.stringify({ file_path: 'native-approval.txt', content: APPROVAL_FILE_CONTENT })}. Do not use bash, edit or other tools. Wait for the native approval result, then give a short acknowledgement.`)
      await poll(() => readObserver(), facts => {
        ensure(readOperator().failed_provider_calls === 0, 'PROVIDER_APPROVAL_FAILED')
        if (facts.sessions.find(session => session.sessionId === LEAD)?.approvals.some(approval => approval.pending)) return true
        ensure((readOperator().sessions.find(session => session.sessionId === LEAD)?.terminals.length ?? 0) === turnsBeforeApproval, 'PROVIDER_APPROVAL_NOT_ASKED')
        return false
      }, 'NATIVE_APPROVAL_NOT_OBSERVED', null)
      const approval = page.locator('[data-approval-key]'); await approval.waitFor({ state: 'visible', timeout: 15000 })
      const beforeApproval = approvalObservation(readObserver(), LEAD), approvalKey = await approval.getAttribute('data-approval-key'), approvals = [], navApproval = native.requests.length
      for (let i = 0; i < 10; i++) {
        const mutations = native.mutations(); await tab(page, CHAT); await tab(page, BLUEPRINT_TAB)
        const observed = approvalObservation(readObserver(), LEAD)
        ensure(observed.pending && observed.callId === beforeApproval.callId && observed.auditId === beforeApproval.auditId
          && await approval.getAttribute('data-approval-key') === approvalKey && native.mutations() === mutations, 'BROWSER_APPROVAL_CHANGED')
        approvals.push({ ordinal: i + 1, observed, mutationDelta: native.mutations() - mutations })
      }
      receipt.navigation_requests.push(...native.requests.slice(navApproval)); receipt.screenshots.push(await image(page, report, 'native-approval'))
      const allow = approval.getByRole('button', { name: /^(?:Allow once|允许一次|允许本次|批准一次)$/i }); ensure(await allow.count() === 1, 'BROWSER_APPROVAL_BUTTON_MISSING'); await allow.click()
      await poll(() => readObserver(), facts => facts.sessions.find(item => item.sessionId === LEAD)?.toolCalls.some(call => call.callId === beforeApproval.callId && call.resultLogged && call.pipelineResultObserved), 'NATIVE_TOOL_NOT_SETTLED')
      const afterApproval = approvalObservation(readObserver(), LEAD), effect = approvalSettlementObservation(readObserver(), LEAD, afterApproval, root)
      receipt.cases.push({ id: 'approval-switch-10-and-write', before: beforeApproval, after: afterApproval, switches: approvals, ...effect }); await idle()
      phase('refresh-and-unrelated-session')
      const beforeView = await view(member.sessionId), beforeRefresh = projectInspection(beforeView.value, beforeView.dom), navRefresh = native.requests.length
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }); const afterView = await view(member.sessionId)
      assert.deepEqual(projectInspection(afterView.value, afterView.dom), beforeRefresh)
      receipt.navigation_requests.push(...native.requests.slice(navRefresh)); receipt.cases.push({ id: 'member-refresh', identityUnchanged: true })
      const plain = await gateway.call('session/create', { request: { sessionId: `teamstage-plain-${randomUUID()}`, cwd: profile.cwd, agentPreset: 'standard' } })
      await prompt('Reply exactly "ordinary conversation". Do not call tools.', plain.sessionId); await idle(plain.sessionId)
      const plainView = await view(plain.sessionId); ensure(plainView.value.status === 'unbound' && !await page.locator('[data-bp-team-stage]').count(), 'BROWSER_PLAIN_SESSION_BOUND')
      receipt.cases.push({ id: 'plain-unbound', sessionId: plain.sessionId, dom: plainView.dom }); receipt.screenshots.push(await image(page, report, 'plain-unbound'))
      await view(member.sessionId)
      const identity = { runId: run.runId, attemptId: run.team.attemptId, stageId: run.team.stageId, teamId: run.team.teamId, taskId: run.team.taskId, sourceSessionId: LEAD }
      phase('same-profile-restart')
      const beforeRestart = await gateway.call('blueprint/inspectRun', { args: { runId: run.runId } }), beforePid = child.pid, beforeOperator = readOperator()
      const beforeSessions = await gateway.call('session/list', { _request: {} })
      ensure(beforeOperator.stream_requests.every(request => request.finished && request.providerOutcome === 'succeeded'), 'PROVIDER_NOT_QUIESCENT')
      receipt.operator_before_restart = beforeOperator; receipt.provider_calls = beforeOperator.provider_calls
      const restarts = []
      for (let repeat = 1; repeat <= 3; repeat++) {
        const previousPid = child.pid
        await stopHost(child); child = undefined; profile.env.XUANLING_TEAMSTAGE_COLLECTOR_OBSERVE_ONLY = '1'
        const restarted = bootHost(profile, receipt.steps, `restart-${repeat}`); child = restarted.child; authUrl = await restarted.ready
        gateway = safeGateway(authUrl, receipt.rpc, repeat + 1); gateway.origin = new URL(authUrl).origin; await gateway.authenticate()
        await poll(() => safeReadJson(paths.ready), value => value?.instance_pid === child.pid && value.operator_ready && value.observation_only, 'HOST_RESTART_OBSERVER_NOT_READY', 30000)
        const navRestart = native.requests.length, mutations = native.mutations()
        await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); await acknowledgeWelcome(); await view(member.sessionId)
        const afterRestart = await gateway.call('blueprint/inspectRun', { args: { runId: run.runId } })
        assert.deepEqual(afterRestart, beforeRestart); ensure(child.pid !== previousPid, 'HOST_RESTART_PID_UNCHANGED')
        const afterOperator = readOperator()
        const listed = await gateway.call('session/list', { _request: {} })
        const nativeAgents = afterOperator.sessions.map(observed => {
          const session = listed.items.find(item => item.sessionId === observed.sessionId)
          const prior = beforeSessions.items.find(item => item.sessionId === observed.sessionId)
          const blank = session?.blank === true && session.origin !== 'subagent' && session.sessionId !== LEAD
          const resumedLead = session?.sessionId === LEAD && session.origin !== 'subagent'
            && observed.start_source === 'resume' && prior?.sessionId === LEAD && prior.blank === session.blank
          ensure((blank || resumedLead) && !run.team.members.some(member => member.sessionId === session.sessionId)
            && !session.running && observed.requests.length === 0 && observed.tools.length === 0, 'HOST_RESTART_TEAM_AGENT_CREATED')
          return { sessionId: session.sessionId, blank: session.blank, start_source: observed.start_source, ordinary: true, resumed_lead: resumedLead }
        })
        ensure(afterOperator.instance_pid === child.pid && afterOperator.observation_only && afterOperator.provider_calls === 0
          && afterOperator.events.length === 0 && native.mutations() === mutations, 'HOST_RESTART_REDISPATCH')
        assert.deepEqual(artifactAudit(root, afterRestart), receipt.artifact_audit)
        const afterProjection = await gateway.call('session/projections', { request: { sessionId: LEAD } })
        assert.deepEqual(afterProjection.values.agentTeam.tasks.map(task => ({ id: task.id, revision: task.revision, status: task.status })), receipt.native_team_projection.tasks)
        assert.deepEqual(afterProjection.values.agentTeam.members.map(member => member.id).sort(), receipt.native_team_projection.members.map(member => member.id).sort())
        receipt.navigation_requests.push(...native.requests.slice(navRestart))
        restarts.push({ repeat, before_pid: previousPid, after_pid: child.pid, mutationDelta: native.mutations() - mutations,
          provider_calls: 0, member_creations: 0, native_agents: nativeAgents, native_task_unchanged: true, record_unchanged: true, artifact_unchanged: true })
        save()
      }
      receipt.restart = { before_pid: beforePid, after_pid: child.pid, before: identity, after: identity,
        mutationDelta: 0, provider_calls: 0, member_creations: 0, same_profile: true,
        record_unchanged: true, artifact_unchanged: true, observation_only: true, observations: restarts }
      receipt.screenshots.push(await image(page, report, 'same-profile-restart'))
      const stream = switches[0].before, artifact = receipt.artifact_audit.items[0]
      const browserReceipt = { schemaVersion: 1, planId: receipt.plan_id, status: 'passed', identity,
        execution: { automatic: true, nodeKind: 'agentTask', stageKind: 'teamStage' }, browserEvidence: true, providerEvidence: true,
        provider: { live: true, name: config.provider, model: config.model, protocol: config.protocol }, source: { kind: beforeView.value.selected.source.kind, sessionId: LEAD },
        team: { ...identity, memberNativeIds: run.team.members.map(member => member.sessionId) }, task: { ...identity, nativeRevision: run.team.taskRevision },
        members: run.team.members.map(member => ({ logicalId: member.memberId, nativeId: member.sessionId, status: member.status, teamId: identity.teamId, taskId: identity.taskId, stageId: identity.stageId })),
        stream: { requestIdentity: stream.requestIdentity, requestCount: stream.identities.length, requestIdentities: stream.identities, mutationDelta: 0 },
        approval: { auditId: afterApproval.auditId, callId: afterApproval.callId, outcome: afterApproval.outcome },
        toolLineage: { name: effect.tool.name, callId: effect.tool.callId, resultObserved: effect.tool.pipelineResultObserved }, restart: receipt.restart,
        artifact: { sha256: artifact.digest, provenance: { ...identity, memberNativeId: artifact.producerSessionId } }, requests: receipt.navigation_requests }
      receipt.browser_contract = validateTeamStageBrowserReceipt(browserReceipt)
      ensure(receipt.browser_contract.status === 'passed', 'BROWSER_CONTRACT_UNVERIFIED')
      writeFileSync(join(report, 'browser-contract.json'), JSON.stringify(browserReceipt, null, 2) + '\n', { mode: 0o600 })
      receipt.status = 'passed'
    }
    ensure(receipt.page_errors.length === 0, 'BROWSER_PAGE_ERRORS')
    ensure(receipt.navigation_requests.every(request => request.mutation === false), 'BROWSER_NAVIGATION_MUTATION')
  } catch (error) {
    receipt.status = 'failed'; receipt.failure = safeCode(error)
    receipt.error_category = ['TimeoutError', 'AssertionError'].includes(error.name) ? error.name : 'typed-operation-failure'
    if (page) await image(page, report, 'failure').then(value => receipt.screenshots.push(value)).catch(() => {})
  }
  finally {
    native?.stop()
    if (paths) { receipt.operator_at_cleanup = safeOperatorFacts(safeReadJson(paths.operatorFacts)); receipt.provider_calls = Math.max(receipt.provider_calls, receipt.operator_at_cleanup.provider_calls) }
    if (profile?.observerFile && existsSync(profile.observerFile)) receipt.public_observer_at_cleanup = publicObserverSnapshot(profile.observerFile)
    if (child) await stopHost(child).catch(error => { receipt.cleanup_failure = safeCode(error); receipt.status = 'failed' })
    if (edge) { await edge.close().catch(error => { receipt.cleanup_failure = safeCode(error); receipt.status = 'failed' }); receipt.native_edge = edge.evidence }
    if (root) { rmSync(root, { recursive: true, force: true }); receipt.cleanup_removed = !existsSync(root) }
    receipt.fingerprint_after = captureEvidenceFingerprint()
    receipt.completed_at = new Date().toISOString()
    ensure(receipt.fingerprint_after.source_sha256 === receipt.fingerprint_before.source_sha256 && receipt.fingerprint_after.artifact_sha256 === receipt.fingerprint_before.artifact_sha256, 'EVIDENCE_FINGERPRINT_CHANGED')
    save()
    const findings = auditArtifacts(report)
    writeFileSync(join(report, 'artifact-audit.json'), JSON.stringify({ passed: findings.length === 0, findings }, null, 2) + '\n')
    ensure(findings.length === 0, 'EVIDENCE_SECRET_PRESENT')
  }
  console.log(JSON.stringify({ status: receipt.status, phase: receipt.phase, failure: receipt.failure ?? null, provider_calls: receipt.provider_calls, key_read: receipt.key_read, cleanup_removed: receipt.cleanup_removed }))
  process.exitCode = receipt.status === 'passed' ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(safeCode(error)); process.exitCode = 1 })
