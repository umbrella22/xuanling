import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { inflateSync } from 'node:zlib'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
export const PLUGIN = join(ROOT, 'integrations/deepseek-harness/xuanling-blueprint')
export const REPORT_ROOT = join(ROOT, 'docs/validation/blueprint/current/conversation')
export const PLAN_ID = 'dsh-blueprint-conversation-v1'
export const sha256 = value => createHash('sha256').update(value).digest('hex')
export const ensure = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }) }
export const identical = isDeepStrictEqual
export function confined(root, path) {
  if (typeof path !== 'string' || !isAbsolute(path)) return false
  const r = relative(root, path)
  return r !== '' && r !== '..' && !r.startsWith('../') && !isAbsolute(r)
}
export function assertPhysicalPath(path) {
  ensure(isAbsolute(path) && resolve(path) === path, 'PATH_NOT_CANONICAL')
  for (let current = path; ; current = dirname(current)) {
    // lstat also catches dangling links; existsSync alone does not.
    try { ensure(!lstatSync(current).isSymbolicLink(), 'PATH_SYMLINK') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (dirname(current) === current) break
  }
}
export function validateNewReportDir(path, root = REPORT_ROOT) {
  ensure(confined(root, path) && resolve(path) === path, 'REPORT_OUTSIDE_ROOT')
  assertPhysicalPath(path)
  ensure(!existsSync(path), 'REPORT_ALREADY_EXISTS')
  return path
}
export function createReportDir(path, root = REPORT_ROOT) {
  validateNewReportDir(path, root)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  assertPhysicalPath(path)
  mkdirSync(path, { mode: 0o700 }) // exclusive: an intervening mkdir is a failure
  return path
}
export function readArtifact(root, path) {
  ensure(confined(root, path), 'ARTIFACT_OUTSIDE_ROOT')
  assertPhysicalPath(path)
  ensure(lstatSync(path).isFile() && confined(realpathSync(root), realpathSync(path)), 'ARTIFACT_NOT_FILE')
  return readFileSync(path)
}
// Deliberately omits arbitrary upstream error text, body, URL, headers and stack.
export function errorCategory(error) {
  return typeof error?.code === 'string' && /^(?:CONVERSATION_|REPORT_|PATH_|ARTIFACT_|CLI_|FIXTURE_|EVIDENCE_|HOST_|BROWSER_|PROVIDER_|SECRET_)[A-Z0-9_]+$/.test(error.code)
    ? error.code : 'CONVERSATION_OPERATION_FAILED'
}
export function secretCategories(text) {
  const patterns = [ ['api-key', /\bsk-[A-Za-z0-9_-]{20,}/], ['access-token', /\b(?:gh[pousr]_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{10,}/],
    ['credential-assignment', /\b(?:authorization|api[_-]?key|authToken|password|cookie)\s*["']?\s*[:=]\s*["']?(?!<redacted>)[^\s,}]{3,}/i],
    ['auth-url', /https?:\/\/[^\s]*[?&](?:token|authToken)=/i], ['secret-canary', /BP[_-]?SECRET[_-]?CANARY/] ]
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([category]) => category)
}
export function auditArtifacts(root) {
  const findings = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      assertPhysicalPath(path)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && /\.(?:json|log|txt)$/.test(entry.name)) {
        for (const category of secretCategories(readArtifact(root, path).toString('utf8'))) findings.push({ path: relative(root, path), category })
      }
    }
  }
  walk(root)
  return findings // paths/categories only; never matched values
}
export function validateScreenshot(item, root, startedAt, finishedAt) {
  ensure(item?.provenance === 'actual Playwright native Edge screenshot', 'EVIDENCE_SCREENSHOT_PROVENANCE')
  const bytes = readArtifact(root, item.path)
  ensure(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.readUInt32BE(16) >= 800 && bytes.readUInt32BE(20) >= 500 && sha256(bytes) === item.sha256, 'EVIDENCE_SCREENSHOT_INVALID')
  // A forged 24-byte PNG header is not an image. Check the complete lossless
  // scanline stream emitted by native Edge, without changing its pixels.
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), idats = []
  let offset = 8, ended = false, header = false, channels
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), kind = bytes.toString('ascii', offset + 4, offset + 8)
    ensure(offset + length + 12 <= bytes.length, 'EVIDENCE_SCREENSHOT_INVALID')
    const payload = bytes.subarray(offset + 8, offset + 8 + length)
    if (kind === 'IHDR') {
      ensure(!header && offset === 8 && length === 13 && payload[8] === 8 && [2, 6].includes(payload[9]) && payload[10] === 0 && payload[11] === 0 && payload[12] === 0, 'EVIDENCE_SCREENSHOT_INVALID')
      header = true; channels = payload[9] === 2 ? 3 : 4
    }
    if (kind === 'IDAT') idats.push(payload)
    offset += length + 12
    if (kind === 'IEND') { ensure(length === 0 && offset === bytes.length, 'EVIDENCE_SCREENSHOT_INVALID'); ended = true; break }
  }
  ensure(header && ended && idats.length > 0, 'EVIDENCE_SCREENSHOT_INVALID')
  const scanlineBytes = height * (1 + width * channels)
  // Collectors capture a fixed 1600x1000 viewport; oversized metadata is invalid.
  ensure(width === 1600 && height === 1000, 'EVIDENCE_SCREENSHOT_INVALID')
  let raw
  try { raw = inflateSync(Buffer.concat(idats), { maxOutputLength: scanlineBytes }) } catch { ensure(false, 'EVIDENCE_SCREENSHOT_INVALID') }
  ensure(raw.length === scanlineBytes, 'EVIDENCE_SCREENSHOT_INVALID')
  const stat = lstatSync(item.path)
  ensure(stat.mtimeMs >= startedAt && stat.mtimeMs <= finishedAt, 'EVIDENCE_SCREENSHOT_STALE')
  const time = Date.parse(item.at)
  ensure(Number.isFinite(time) && time >= startedAt && time <= finishedAt, 'EVIDENCE_SCREENSHOT_STALE')
}
export function validatePnpmInstallEvidence(receipt) {
  const available = receipt.steps?.filter(step => step.id === 'pnpm-available')
  const step = available?.[0], executable = receipt.provenance?.pnpm
  ensure(available?.length === 1 && step.passed === true && step.exitCode === 0 && !step.signal && !step.errorCategory
    && ['explicit', 'PATH'].includes(step.source) && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(step.version ?? '')
    && typeof executable?.path === 'string' && isAbsolute(executable.path) && /^[a-f0-9]{64}$/.test(executable.sha256 ?? '')
    && identical(executable, step.executable) && ['node', 'direct'].includes(executable.runner)
    && (executable.packageName !== 'pnpm' || step.version === executable.packageVersion)
    && /^[a-f0-9]{64}$/.test(step.shimSha256 ?? '') && identical(step.args, ['--version']), 'EVIDENCE_PNPM_UNAVAILABLE_OR_CHANGED')
}
export function validateCollectorGate(receipt, { reportDir, fingerprint, fingerprintAfter, evidenceRoot = REPORT_ROOT }) {
  ensure(receipt?.planId === PLAN_ID && receipt.status === 'passed', 'EVIDENCE_REPORT_FAILED')
  const validFingerprint = fp => /^[a-f0-9]{40}$/.test(fp?.revision ?? '')
    && /^[a-f0-9]{64}$/.test(fp?.source_sha256 ?? '') && /^[a-f0-9]{64}$/.test(fp?.artifact_sha256 ?? '')
  ensure(validFingerprint(fingerprint) && validFingerprint(fingerprintAfter) && identical(fingerprint, fingerprintAfter)
    && identical(receipt.fingerprint, fingerprint) && identical(receipt.fingerprintAfter, fingerprintAfter), 'EVIDENCE_FINGERPRINT_CHANGED')
  ensure(receipt.provenance?.helpers?.length === 8 && receipt.provenance.helpers.every(item => /^[a-f0-9]{64}$/.test(item.sha256))
    && identical(receipt.provenance, receipt.provenanceAfter), 'EVIDENCE_COLLECTOR_PROVENANCE_CHANGED')
  ensure(['readiness', 'keyless', 'live'].includes(receipt.mode) && ['cli', 'linked'].includes(receipt.installMode)
    && receipt.keyRead === false && receipt.pageErrors === 0 && !receipt.failure, 'EVIDENCE_MODE_OR_FAILURE_INVALID')
  const start = Date.parse(receipt.startedAt), end = Date.parse(receipt.finishedAt)
  ensure(Number.isFinite(start) && Number.isFinite(end) && end >= start, 'EVIDENCE_TIME_INVALID')
  assertPhysicalPath(reportDir)
  ensure(confined(evidenceRoot, reportDir), 'EVIDENCE_REPORT_OUTSIDE_ROOT')
  ensure(existsSync(reportDir) && lstatSync(reportDir).isDirectory(), 'EVIDENCE_REPORT_DIRECTORY_MISSING')
  const browser = receipt.browser
  ensure(browser?.kind === 'owned native Edge CDP' && browser.noDefaults === true && browser.defaultContext === true
    && browser.closed === true && browser.profileRemoved === true && Number.isSafeInteger(browser.pid) && browser.pid > 0
    && browser.args?.includes('--headless=new') && browser.args.includes('--remote-debugging-port=0')
    && browser.args.includes(`--user-data-dir=${browser.profile}`), 'EVIDENCE_NATIVE_BROWSER_MISSING')
  ensure(receipt.cleanup?.hostStopped === true && receipt.cleanup.isolationRemoved === true && !receipt.cleanup.failure, 'EVIDENCE_CLEANUP_FAILED')
  ensure(receipt.boot?.authenticated === true && receipt.boot.pluginPing === true && receipt.boot.actualBrowser === true
    && receipt.boot.clientBundle?.status === 200 && receipt.boot.clientBundle.closure === true
    && receipt.boot.clientEntry === '@xuanling-rs/xuanling-dsh-blueprint'
    && /^[a-f0-9]{64}$/.test(receipt.package?.artifactSha256 ?? '') && receipt.package.artifactSha256 === receipt.package.artifactSha256After
    && Number.isSafeInteger(receipt.package.artifactCount) && receipt.package.artifactCount >= 2
    && /^[a-f0-9]{64}$/.test(receipt.package?.indexSha256 ?? '') && /^[a-f0-9]{64}$/.test(receipt.package?.clientSha256 ?? ''), 'EVIDENCE_INSTALLED_BOOT_MISSING')
  for (const id of receipt.installMode === 'cli' ? ['version', 'pack', 'init', 'install', 'boot'] : ['version', 'linked-profile', 'boot']) {
    const steps = receipt.steps?.filter(step => step.id === id)
    ensure(steps?.length === 1 && steps[0].passed === true, 'EVIDENCE_CLI_STEP_FAILED')
    if (!['boot', 'linked-profile'].includes(id)) ensure(steps[0].exitCode === 0 && !steps[0].signal && !steps[0].errorCategory, 'EVIDENCE_CLI_EXIT_FAILED')
  }
  if (receipt.installMode === 'cli') validatePnpmInstallEvidence(receipt)
  ensure(receipt.rpc?.length > 0 && receipt.rpc.every(item => item.status === 200 && item.ok === true
    && item.provenance === 'real public DSH gateway' && typeof item.rpcId === 'string' && item.rpcId.length > 0 && item.responseRpcId === item.rpcId
    && Date.parse(item.at) >= start && Date.parse(item.at) <= end), 'EVIDENCE_GATEWAY_CORRELATION_INVALID')
  ensure(receipt.rpc.some(item => item.method === 'blueprint/ping'), 'EVIDENCE_GATEWAY_PING_MISSING')
  ensure(receipt.observer?.provenance === 'public DSH observer' && Array.isArray(receipt.observer.sessions), 'EVIDENCE_OBSERVER_MISSING')
  const requests = receipt.observer.sessions.flatMap(item => item.requests)
  ensure(requests.every(item => typeof item?.identity === 'string' && item.identity && Number.isInteger(item.ordinal)
    && Number.isInteger(item.turn) && Number.isInteger(item.step) && item.failed === false)
    && new Set(requests.map(item => item.identity)).size === requests.length
    && receipt.observer.sessions.every(item => item.runtimeError === false), 'EVIDENCE_PROVIDER_IDENTITY_INVALID')
  if (receipt.mode !== 'live') ensure(requests.length === 0 && receipt.providerEvidence === false && receipt.notRun?.includes('real-provider'), 'EVIDENCE_KEYLESS_PROVIDER_CLAIM')
  else ensure(requests.length > 0 && receipt.providerEvidence === true && receipt.credentialReader === 'isolated DSH child preload'
    && receipt.notRun?.length === 0, 'EVIDENCE_LIVE_PROVIDER_MISSING')
  if (receipt.mode === 'readiness') {
    ensure(receipt.browserEvidence === false && receipt.cases.length === 0, 'EVIDENCE_READINESS_OVERSOLD')
    return { ok: true, mode: receipt.mode, browserEvidence: false, providerEvidence: false, installEvidence: receipt.installMode === 'cli' }
  }
  ensure(receipt.browserEvidence === true && receipt.provenance.fixture?.path?.endsWith('.mjs')
    && /^[a-f0-9]{64}$/.test(receipt.provenance.fixture.sha256), 'EVIDENCE_FIXTURE_PROVENANCE_MISSING')
  const ids = ['native-tab', 'native-draft', 'refresh-attempt', 'frozen-graph', 'plain-unbound', 'host-restart',
    ...(receipt.mode === 'live' ? ['stream-switch-10', 'native-approval', 'tool-lineage', 'child-artifact'] : [])]
  ensure(receipt.cases?.length === ids.length && new Set(receipt.cases.map(item => item.id)).size === ids.length
    && ids.every(id => receipt.cases.some(item => item.id === id)), 'EVIDENCE_CASES_MISSING_OR_DUPLICATE')
  for (const item of receipt.cases) {
    ensure(item.provenance === 'actual native browser + public gateway' && Date.parse(item.at) >= start && Date.parse(item.at) <= end, 'EVIDENCE_CASE_PROVENANCE_INVALID')
    validateScreenshot(item.screenshot, reportDir, start, end)
  }
  const facts = id => receipt.cases.find(item => item.id === id).facts
  const tab = facts('native-tab'), draft = facts('native-draft'), refresh = facts('refresh-attempt'), frozen = facts('frozen-graph'), plain = facts('plain-unbound')
  ensure(tab.nativeTab === true && tab.viewId === 'xuanling-blueprint' && tab.sessionId === receipt.sessionId && tab.nestedComposers === 0, 'EVIDENCE_NATIVE_TAB_INVALID')
  ensure(draft.sessionId === receipt.sessionId && draft.nativeComposerCount === 1 && /^[a-f0-9]{64}$/.test(draft.beforeSha256 ?? '')
    && draft.beforeSha256 === draft.switchedSha256 && draft.beforeSha256 === draft.reloadedSha256, 'EVIDENCE_NATIVE_DRAFT_CHANGED')
  ensure(identical(refresh.before, refresh.after) && refresh.before.runId && refresh.before.revision && refresh.before.focusAttemptIds?.length > 0
    && refresh.before.attempts?.length === refresh.before.focusAttemptIds.length
    && refresh.executionSessionEvidence === (receipt.mode === 'live')
    && refresh.before.attempts.every(item => item.attemptId && item.nodeId && (receipt.mode !== 'live' || item.sessionId)
      && refresh.before.focusAttemptIds.includes(item.attemptId)), 'EVIDENCE_ATTEMPT_REFRESH_CHANGED')
  ensure(identical(frozen.before, refresh.before) && identical(frozen.before, frozen.after) && frozen.definitionChanged === true
    && frozen.liveDefinitionBefore && frozen.liveDefinitionRevision !== frozen.liveDefinitionBefore
    && frozen.liveSemanticBefore && frozen.liveSemanticAfter !== frozen.liveSemanticBefore
    && typeof frozen.changedNodeId === 'string' && !frozen.after.nodeIds?.includes(frozen.changedNodeId), 'EVIDENCE_FROZEN_GRAPH_CONFUSED')
  ensure(plain.sessionId && plain.sessionId !== plain.sourceSessionId && plain.sourceSessionId === receipt.sessionId && plain.hostStatus === 'unbound'
    && plain.dom?.sessionId === plain.sessionId && !plain.dom.runId && plain.dom.nodes?.length === 0 && plain.dom.attempts?.length === 0, 'EVIDENCE_PLAIN_SESSION_BOUND')
  const restart = receipt.restart, restored = facts('host-restart')
  ensure(restart?.invoked === true && restart.stopped === true && restart.sameProfile === true
    && restart.authenticated === true && restart.pluginPing === true
    && Number.isSafeInteger(restart.firstPid) && restart.firstPid > 0
    && Number.isSafeInteger(restart.secondPid) && restart.secondPid > 0 && restart.firstPid !== restart.secondPid
    && Date.parse(restart.at) >= start && Date.parse(restart.finishedAt) >= Date.parse(restart.at) && Date.parse(restart.finishedAt) <= end
    && restart.clientBundle?.status === 200 && restart.clientBundle.closure === true, 'EVIDENCE_HOST_RESTART_NOT_INVOKED')
  const firstBoot = receipt.steps.find(step => step.id === 'boot'), secondBoots = receipt.steps.filter(step => step.id === 'boot-2'), stops = receipt.steps.filter(step => step.id === 'stop-for-restart')
  ensure(secondBoots.length === 1 && stops.length === 1 && secondBoots[0].passed === true && stops[0].passed === true
    && firstBoot.pid === restart.firstPid && stops[0].pid === restart.firstPid && secondBoots[0].pid === restart.secondPid
    && (Number.isInteger(stops[0].exitCode) || typeof stops[0].signal === 'string')
    && typeof firstBoot.command === 'string' && firstBoot.command.length > 0 && firstBoot.command === secondBoots[0].command
    && Array.isArray(firstBoot.args) && typeof firstBoot.args[1] === 'string' && firstBoot.args[1].length > 0
    && identical(firstBoot.args, ['--profile', firstBoot.args[1], '--host', '127.0.0.1', '--port', '0', '--no-open'])
    && identical(firstBoot.args, secondBoots[0].args)
    && Date.parse(stops[0].at) >= Date.parse(restart.at) && Date.parse(secondBoots[0].at) >= Date.parse(stops[0].at), 'EVIDENCE_HOST_RESTART_PROCESS_MISSING')
  ensure(restart.firstObserverSha256 === sha256(JSON.stringify(receipt.observer))
    && restart.observer?.provenance === 'public DSH observer' && Array.isArray(restart.observer.sessions)
    && restart.observer.sessions.every(item => item.requests.length === 0 && item.approvals.length === 0 && item.runtimeError === false)
    && Array.isArray(restart.nativeRequests) && restart.nativeRequests.every(item => item.mutation === false)
    && restored.mutationDelta === 0
    && receipt.rpc.filter(item => item.hostInstance === 2).some(item => item.method === 'blueprint/ping')
    && receipt.rpc.filter(item => item.hostInstance === 2).some(item => item.method === 'blueprint/inspectSession')
    && receipt.rpc.filter(item => item.hostInstance === 2).every(item => Date.parse(item.at) >= Date.parse(restart.at)
      && ['blueprint/ping', 'blueprint/inspectSession', 'session/list', 'session/projections'].includes(item.method)), 'EVIDENCE_HOST_RESTART_SIDE_EFFECT_OR_OBSERVER_CHANGED')
  ensure(identical(restored.before, restored.after) && identical(restored.before, refresh.before)
    && restored.sourceSessionId === receipt.sessionId && restored.sourceBefore?.sessionId === receipt.sessionId
    && identical(restored.sourceBefore, restored.sourceAfter)
    && restored.runStateBefore === restored.runStateAfter
    && (receipt.mode === 'live' ? restored.runStateBefore === 'succeeded' : restored.runStateBefore === 'waiting_input')
    && restored.executionSessionEvidence === (receipt.mode === 'live'), 'EVIDENCE_HOST_RESTART_FROZEN_IDENTITY_CHANGED')
  if (receipt.mode === 'live') {
    const stream = facts('stream-switch-10'), approval = facts('native-approval'), lineage = facts('tool-lineage')
    ensure(stream.switches?.length === 10, 'EVIDENCE_TEN_SWITCHES_REQUIRED')
    let baseline
    for (const [i, item] of stream.switches.entries()) {
      const a = item.before, b = item.after
      baseline ??= a
      ensure(item.ordinal === i + 1 && item.mutationDelta === 0 && a.sessionId === stream.sessionId && b.sessionId === stream.sessionId
        && a.active === true && b.active === true && !a.failed && !b.failed && a.textDeltas > 0 && b.textDeltas >= a.textDeltas
        && a.requestIdentity && a.requestIdentity === b.requestIdentity && a.requestIdentity === baseline.requestIdentity
        && a.totalCalls === b.totalCalls && a.totalCalls === baseline.totalCalls && a.totalCalls > 0
        && identical(a.identities, b.identities) && identical(a.identities, baseline.identities)
        && a.identities.length === a.totalCalls && new Set(a.identities).size === a.totalCalls
        && requests.some(request => request.identity === a.requestIdentity), 'EVIDENCE_STREAM_SWITCH_FAILED')
    }
    ensure(approval.nativeKey && approval.before?.pending === true && approval.before.auditId && approval.before.callId
      && approval.identities?.length === 10 && approval.identities.every(item => item.nativeKey === approval.nativeKey && item.mutationDelta === 0
        && item.observed?.sessionId === approval.sessionId && item.observed.pending === true && item.observed.auditId === approval.before.auditId && item.observed.callId === approval.before.callId)
      && approval.after?.pending === false && approval.after.outcome === 'allowed-once' && approval.after.auditId === approval.before.auditId
      && approval.after.callId === approval.before.callId
      && approval.after.decidedLogged === true && Number.isInteger(approval.before.askedSeq) && approval.after.decidedSeq > approval.before.askedSeq
      && receipt.observer.sessions.find(session => session.sessionId === approval.sessionId)?.approvals.some(item => item.auditId === approval.before.auditId && item.callId === approval.before.callId
        && item.outcome === 'allowed-once' && item.decidedLogged && item.decidedSeq > item.askedSeq), 'EVIDENCE_NATIVE_APPROVAL_INVALID')
    ensure(approval.tool?.name === 'write' && approval.tool.callId === approval.before.callId
      && approval.tool.isError === false && approval.tool.pipelineIsError === false && approval.tool.pipelineResultObserved === true
      && Number.isInteger(approval.tool.resultSeq) && approval.tool.resultSeq > approval.after.decidedSeq
      && approval.effect?.category === 'isolated-native-write' && approval.effect.sha256 === sha256('isolated conversation approval fixture\n')
      && approval.effect.bytes === Buffer.byteLength('isolated conversation approval fixture\n')
      && receipt.observer.sessions.find(session => session.sessionId === approval.sessionId)?.toolCalls.some(item => item.name === 'write'
        && item.callId === approval.tool.callId && item.callLogged && item.resultLogged && item.ok === true && item.isError === false
        && item.pipelineIsError === false && item.pipelineResultObserved === true && item.resultSeq === approval.tool.resultSeq
        && item.resultSeq > approval.after.decidedSeq), 'EVIDENCE_NATIVE_APPROVAL_EFFECT_MISSING')
    ensure(lineage.sessionId === receipt.sessionId && lineage.nativeToolResultObserved === true && lineage.toolName === 'blueprint_start'
      && Number.isInteger(lineage.turn) && lineage.turn >= 0 && lineage.callId && lineage.runId
      && receipt.observer.sessions.find(session => session.sessionId === lineage.sessionId)?.toolCalls.some(item => item.callId === lineage.callId && item.name === 'blueprint_start'
        && item.ok === true && item.callLogged && item.resultLogged && item.pipelineResultObserved && item.turn === lineage.turn && item.resultSeq > item.callSeq), 'EVIDENCE_NATIVE_TOOL_LINEAGE_MISSING')
    const tools = receipt.observer.sessions.find(session => session.sessionId === lineage.sessionId).toolCalls
    ensure([['blueprint_list', lineage.catalogCallId], ['blueprint_inspect', lineage.inspectCallId]].every(([name, callId]) =>
      callId && tools.some(item => item.name === name && item.callId === callId && item.ok && item.callLogged && item.resultLogged
        && item.pipelineResultObserved && item.resultSeq > item.callSeq)), 'EVIDENCE_NATIVE_TOOL_CATALOG_OR_INSPECT_MISSING')
    const child = facts('child-artifact'), sourceCall = tools.find(item => item.callId === lineage.callId)
    ensure(child.runId === lineage.runId && child.sessionId === lineage.sessionId && child.sourceCallId === lineage.callId
      && child.executionSessionId && child.executionSessionId === refresh.before.sessionId
      && child.attemptId && child.downstreamAttemptId && child.attemptId !== child.downstreamAttemptId
      && child.state === 'succeeded' && child.resultKind === 'succeeded' && child.acceptanceCode === 'accepted'
      && /^[a-f0-9]{64}$/.test(child.inputSha256 ?? '') && child.inputSha256 === sourceCall.inputSha256
      && child.inputSha256 === child.outputSha256 && child.outputSha256 === child.downstreamSha256
      && refresh.before.attempts.some(item => item.attemptId === child.attemptId && item.sessionId === child.executionSessionId)
      && receipt.observer.sessions.some(item => item.sessionId === child.executionSessionId && item.requests.length > 0)
      && restored.sourceBefore.kind === 'tool' && restored.sourceBefore.callId === lineage.callId
      && restored.sourceBefore.turn === lineage.turn, 'EVIDENCE_CHILD_ARTIFACT_MISMATCH')
  }
  ensure(receipt.rpc.some(item => item.method === 'blueprint/inspectSession') && receipt.rpc.some(item => item.method === 'blueprint/loadDefinition'), 'EVIDENCE_PUBLIC_INSPECT_MISSING')
  return { ok: true, mode: receipt.mode, cases: ids.length, browserEvidence: true, providerEvidence: receipt.mode === 'live', installEvidence: receipt.installMode === 'cli' }
}
