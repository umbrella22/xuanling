#!/usr/bin/env node
/** Main runs only after backend/client review and a frozen build. No adapter,
 * fake host, synthetic provider, ambient key, default profile, or old report. */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { PLAN_ID, ROOT, REPORT_ROOT, PLUGIN, ensure, createReportDir, validateNewReportDir, assertPhysicalPath,
  sha256, identical, errorCategory, auditArtifacts, validateCollectorGate } from './conversation-evidence.mjs'
import { prepareProfile, bootHost, stopHost, makeGateway, isolatedEnvironment, artifactInventory, pnpmExecutableProvenance } from './conversation-runtime.mjs'
import { runConversationBrowser, publicObserverSnapshot, observeNativeRequests } from './conversation-browser.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const HELP = `Independent native DSH conversation collector (Main review/build required).
Usage:
  node --experimental-transform-types test/blueprint/capabilities/conversation-ui.mjs --plan-id ${PLAN_ID} --mode readiness --install-mode linked --report-dir <absolute-NEW-directory-under-${REPORT_ROOT}>
  node --experimental-transform-types test/blueprint/capabilities/conversation-ui.mjs --plan-id ${PLAN_ID} --mode readiness --install-mode cli --pnpm-executable <absolute-installed-pnpm-bin.cjs-or-mjs> --report-dir <absolute-NEW-directory>
  node --experimental-transform-types test/blueprint/capabilities/conversation-ui.mjs --plan-id ${PLAN_ID} --mode keyless --install-mode cli --fixture <absolute-main-reviewed-fixture.mjs> --report-dir <absolute-NEW-directory>
  node --experimental-transform-types test/blueprint/capabilities/conversation-ui.mjs --plan-id ${PLAN_ID} --mode live --install-mode cli --fixture <absolute-main-reviewed-fixture.mjs> --key-file <absolute-isolated-key.txt> --provider-base-url <https-endpoint-without-auth-query> --provider-model <model-id> --provider-protocol <openai-completions|openai-responses|anthropic-messages> --report-dir <absolute-NEW-directory>
Flags (both --flag value and --flag=value; unknown/duplicate/missing rejected):
  --help                    Standalone; no imports of Host/product code, installs, key read or calls.
  --plan-id                 Required, exactly ${PLAN_ID}.
  --mode                    Required: readiness | keyless | live.
  --install-mode            Required: cli | linked. cli uses real npm pack --ignore-scripts,
                            dsh --profile NAME --from-default-profile web --dump-config,
                            dsh plugin --profile NAME add TARBALL. linked uses the public
                            isolated profile manifest + Main-built package symlink;
                            linked is NOT tarball-install evidence.
  --pnpm-executable         Optional, cli install only: absolute canonical physical real pnpm CLI.
                            Supports installed pnpm Node bin (.js/.cjs/.mjs) or native executable.
                            Without it, discovers actual pnpm from PATH; unavailable fails typed.
                            Executes --version in isolation, then an owned bin/pnpm exec shim
                            forwards argv/exit using real Node/CLI. Only install CLI PATH changes.
                            No cache guessing/bootstrap; entry, package and implementation SHA
                            are bound in provenance before/after. No ambient credentials/config.
  --report-dir              Required absolute canonical NEW descendant of ${REPORT_ROOT}.
                            Existing output, traversal, escapes and symlink ancestors rejected.
  --fixture                 Required for keyless/live; absolute physical Main-reviewed .mjs.
                            Supplied implementation: ${join(HERE, 'conversation-fixture.mjs')}.
  --key-file                Live only. Absolute physical isolated file; collector NEVER opens it.
                            Only explicitly opted-in DSH child preload reads it; no value in report.
  --provider-base-url        Live only, HTTPS non-loopback, no credentials/query/fragment.
  --provider-model           Live only, exact operator-selected model ID.
  --provider-protocol        Live only, explicit protocol from the list above.
Real boot: dsh --profile NAME --host 127.0.0.1 --port 0 --no-open;
isolated HOME/DSH_HOME; authenticated public gateway; launchOwnedEdge public CDP noDefaults/default context.
No build is performed. readiness proves boot/client entry/Edge only. keyless requires 6 cases:
native tab/draft, unbound Session, refresh Attempt, frozen graph and actual same-profile host restart.
The supplied keyless fixture seeds nonblank Sessions through public session/prompt with a dedicated
agent/pre-step guard rejecting before model dispatch, then starts an input/humanDecision waiting Run.
Its restart observes durable waiting_input quiescence, not terminal Agent execution lineage.
keyless does NOT prove streaming, pending approval or provider calls. live requires all 10 cases,
including 10 streaming tab round trips with stable real request identities/counts and zero mutations,
native approval identity retention plus successful Session/tool and public Tools results after the decision,
and actual isolated native-approval.txt bytes (receipt stores only SHA/bytes/category).
live additionally requires native blueprint_list/start/inspect, actual child/downstream nonce artifacts,
and a terminal succeeded Run across actual stop/boot-2/reauth and native execution Session focus.
First-host observer facts are sealed and preserved; second-host facts independently require zero calls.
Native child navigation must be supported by the product; orphan subagent Sessions fail typed.
No missing scene or provider may be replaced by a mock. Failed/missing evidence exits 1 (invalid CLI exits 2).
Reports are lightweight receipt.json, collector.log and masked native screenshots; no source snapshots/raw logs.

Main-owned fixture module contract (operator setup/actions ONLY; it cannot return acceptance facts):
  prepare({root,mode}) -> {blueprints:{logicalId:absoluteDirUnderRoot},operatorModules?:[absoluteMjsUnderRoot]}
    Creates ephemeral real blueprints and optional public DSH Session/Tools setup plugins. No fake provider.
  arrange({page,gateway,root,mode}) -> {sessionId,plainSessionId,blueprintId,definitionPath,
                                     executionSessionId?,streamSessionId?,inputJson?}
    Creates real native nonblank Sessions and real bound Run via public Host paths. All locators are rechecked.
  openSession({page,gateway,sessionId}) -> void
    Uses actual native navigation; no page.route/fulfill/HAR interception or injected UI/Host state.
  startStreaming({page,gateway,root,scene}) -> {sessionId?}  [live required]
  startApproval({page,gateway,root,scene}) -> {sessionId?}   [live required]
    Performs explicit public/native real-provider actions; real Tools approval required. No synthetic stream.
gateway.call(method,wireArgs) uses the public RPC envelope {payload:{args:wireArgs}}; for blueprint methods
wireArgs is {args:{...}}, for session/create and session/prompt it is {request:{...}};
session/prompt requires requestId, mode:queue and content:[{type:text,text}]; session/list is {_request:{}}.
inputJson is expected fixture input configuration, never evidence of execution. Allowed methods are exported by
conversation-runtime.mjs. Do NOT return a receipt, provider count or synthetic inspector. Fixture digest,
observer code, collector helpers and source/build fingerprints are bound before/after the run.
Native observation: view xuanling-blueprint, [data-conversation-tabs] [role=tab],
[data-bp-conversation=root], data-bp-session/run-id/frozen-revision, data-bp-node/raw-state,
data-bp-attempt-id; existing [data-composer-input][role=textbox] and [data-approval-key].
The worker prepares code only; Main supplies and reviews the fixture, credential and live action intent.
`
export function parseCli(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true }
  const values = {}, flags = ['--plan-id', '--mode', '--install-mode', '--pnpm-executable', '--report-dir', '--fixture', '--key-file', '--provider-base-url', '--provider-model', '--provider-protocol']
  for (let i = 0; i < args.length; i++) {
    const equals = args[i].indexOf('='), flag = equals < 0 ? args[i] : args[i].slice(0, equals)
    const value = equals < 0 ? args[++i] : args[i].slice(equals + 1)
    ensure(flags.includes(flag) && !Object.hasOwn(values, flag), 'CLI_UNKNOWN_OR_DUPLICATE_FLAG')
    ensure(typeof value === 'string' && value.length > 0 && value.trim() === value && !value.startsWith('--')
      && [...value].every(char => char.codePointAt(0) > 31 && char.codePointAt(0) !== 127), 'CLI_VALUE_REQUIRED')
    values[flag] = value
  }
  ensure(values['--plan-id'] === PLAN_ID, 'CLI_PLAN_ID_REQUIRED')
  ensure(['readiness', 'keyless', 'live'].includes(values['--mode']), 'CLI_MODE_REQUIRED')
  ensure(['cli', 'linked'].includes(values['--install-mode']), 'CLI_INSTALL_MODE_REQUIRED')
  const options = { planId: PLAN_ID, mode: values['--mode'], installMode: values['--install-mode'], reportDir: values['--report-dir'],
    fixture: values['--fixture'], keyFile: values['--key-file'], providerBaseUrl: values['--provider-base-url'],
    providerModel: values['--provider-model'], providerProtocol: values['--provider-protocol'], pnpmExecutable: values['--pnpm-executable'] }
  validateNewReportDir(options.reportDir)
  if (options.pnpmExecutable) {
    ensure(options.installMode === 'cli', 'CLI_PNPM_REQUIRES_CLI_INSTALL')
    pnpmExecutableProvenance(options.pnpmExecutable)
  }
  if (options.mode !== 'readiness') ensure(options.fixture, 'CLI_FIXTURE_REQUIRED')
  for (const path of [options.fixture, options.keyFile].filter(Boolean)) {
    ensure(isAbsolute(path) && resolve(path) === path, 'CLI_PATH_NOT_ABSOLUTE'); assertPhysicalPath(path)
  }
  if (options.fixture) ensure(options.fixture.endsWith('.mjs'), 'CLI_FIXTURE_NOT_MODULE')
  const liveFields = [options.keyFile, options.providerBaseUrl, options.providerModel, options.providerProtocol]
  if (options.mode === 'live') {
    ensure(liveFields.every(value => value), 'CLI_LIVE_CONFIG_REQUIRED')
    let url
    try { url = new URL(options.providerBaseUrl) } catch { ensure(false, 'CLI_PROVIDER_URL_INVALID') }
    ensure(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && !['localhost', '[::1]', '::1'].includes(url.hostname) && !/^(?:127\.|0\.|169\.254\.)/.test(url.hostname), 'CLI_PROVIDER_URL_INVALID')
    ensure(['openai-completions', 'openai-responses', 'anthropic-messages'].includes(options.providerProtocol), 'CLI_PROVIDER_PROTOCOL_INVALID')
  } else ensure(liveFields.every(value => value === undefined), 'CLI_LIVE_FLAGS_IN_KEYLESS_MODE')
  return options
}

export function collectorProvenance(fixture, pnpmExecutable) {
  const paths = ['conversation-ui.mjs', 'conversation-evidence.mjs', 'conversation-runtime.mjs', 'conversation-browser.mjs',
    'conversation-observer.mjs', 'conversation-credential.mjs', 'comfy-motion-ui.mjs', 'probe.mjs']
  return { helpers: paths.map(path => ({ path, sha256: sha256(readFileSync(join(HERE, path))) })),
    fixture: fixture ? { path: fixture, sha256: sha256(readFileSync(fixture)) } : null,
    pnpm: pnpmExecutable ? pnpmExecutableProvenance(pnpmExecutable) : null }
}
export function resolvePlaywrightModule(namespace) {
  // CJS dynamic imports may expose Playwright only under default. Preserve the
  // actual exported object and Chromium receiver used by launchOwnedEdge.
  const pw = [namespace, namespace?.default].find(candidate => typeof candidate?.chromium?.connectOverCDP === 'function')
  ensure(pw, 'BROWSER_PLAYWRIGHT_CHROMIUM_UNAVAILABLE')
  return pw
}
export function validateFixtureExports(fixture, mode) {
  const names = ['prepare', ...(mode === 'readiness' ? [] : ['arrange', 'openSession']),
    ...(mode === 'live' ? ['startStreaming', 'startApproval'] : [])]
  ensure(names.every(name => typeof fixture?.[name] === 'function'), 'FIXTURE_EXPORTS_MISSING')
  return fixture
}
export async function restartOwnedHost({ profile, firstHost, receipt, mode, onBoot },
  { stop = stopHost, boot = bootHost, gatewayFactory = makeGateway, readObserver = publicObserverSnapshot } = {}) {
  const restart = receipt.restart = { invoked: true, at: new Date().toISOString(), firstPid: firstHost.child.pid,
    stopped: false, authenticated: false, pluginPing: false, sameProfile: false }
  const profileSha256 = sha256(profile.profile)
  await stop(firstHost.child)
  ensure(firstHost.child.exitCode !== null || firstHost.child.signalCode !== null, 'HOST_RESTART_STOP_FAILED')
  restart.stopped = true
  receipt.steps.push({ id: 'stop-for-restart', at: new Date().toISOString(), passed: true, pid: firstHost.child.pid,
    exitCode: firstHost.child.exitCode, signal: firstHost.child.signalCode })
  // Keep the original observer file. The new process writes a different file,
  // so cold-start emptiness cannot replace first-host model/tool/approval facts.
  receipt.observer = readObserver(profile.observerFile)
  restart.firstObserverSha256 = sha256(JSON.stringify(receipt.observer))
  const observerFile = join(dirname(profile.observerFile), 'observer-restart-facts.json')
  const secondProfile = { ...profile, env: { ...profile.env, BP_CONVERSATION_OBSERVER_FILE: observerFile } }
  const host = boot(secondProfile, receipt.steps, 'boot-2')
  onBoot(host)
  restart.secondPid = host.child.pid
  ensure(restart.firstPid !== restart.secondPid, 'HOST_RESTART_PROCESS_ID_REUSED')
  restart.sameProfile = profileSha256 === sha256(secondProfile.profile)
  const authUrl = await host.ready, gateway = gatewayFactory(authUrl, receipt.rpc, mode, 2)
  await gateway.authenticate(); restart.authenticated = true
  const ping = await gateway.call('blueprint/ping', {})
  ensure(ping.status === 'ok' && ping.service === receipt.package.name, 'HOST_RESTART_PLUGIN_NOT_MOUNTED')
  restart.pluginPing = true
  return { gateway, authUrl, observerFile }
}
export async function runCollector(options) {
  createReportDir(options.reportDir)
  const receipt = { schemaVersion: 1, planId: PLAN_ID, mode: options.mode, installMode: options.installMode,
    startedAt: new Date().toISOString(), status: 'failed', keyRead: false, credentialReader: options.mode === 'live' ? 'isolated DSH child preload' : null,
    providerEvidence: false, browserEvidence: false, cases: [], steps: [], rpc: [], nativeRequests: [],
    observer: { provenance: 'public DSH observer', sessions: [] }, cleanup: { hostStopped: false, isolationRemoved: false },
    notRun: options.mode === 'live' ? [] : ['real-provider', 'stream-switch-10', 'native-approval', 'tool-lineage'] }
  let tempRoot, host, edge, page, native, profile, captureEvidenceFingerprint, before, provenance
  try {
    ;({ captureEvidenceFingerprint } = await import(pathToFileURL(join(PLUGIN, 'scripts/verify.mjs')).href))
    before = captureEvidenceFingerprint(); provenance = collectorProvenance(options.fixture, options.pnpmExecutable)
    receipt.fingerprint = before; receipt.provenance = provenance
    tempRoot = mkdtempSync(join(realpathSync(tmpdir()), 'bp-conversation-'))
    let fixture
    if (options.fixture) {
      fixture = validateFixtureExports(await import(pathToFileURL(options.fixture).href), options.mode)
    }
    profile = await prepareProfile(options, fixture, tempRoot, receipt.steps)
    if (profile.packageManager) provenance.pnpm = profile.packageManager.executable
    receipt.package = { name: '@xuanling-rs/xuanling-dsh-blueprint', mount: options.installMode === 'cli' ? 'CLI installed tarball' : 'Main-built linked package',
      indexSha256: sha256(readFileSync(join(profile.installedPackage, 'lib/index.js'))), clientSha256: sha256(readFileSync(join(profile.installedPackage, 'lib/client.js'))),
      artifactSha256: sha256(JSON.stringify(profile.installedInventory)), artifactCount: profile.installedInventory.length }
    host = bootHost(profile, receipt.steps)
    const authUrl = await host.ready, gateway = makeGateway(authUrl, receipt.rpc, options.mode)
    await gateway.authenticate()
    const ping = await gateway.call('blueprint/ping', {})
    ensure(ping.status === 'ok' && ping.service === receipt.package.name, 'HOST_PLUGIN_NOT_MOUNTED')
    const require = createRequire(join(ROOT, 'test/blueprint/package.json'))
    const pw = resolvePlaywrightModule(await import(pathToFileURL(require.resolve('playwright')).href))
    const { launchOwnedEdge } = await import('./comfy-motion-ui.mjs')
    // Credential preload belongs solely to DSH, never to Edge or npm/installer.
    edge = await launchOwnedEdge(pw, isolatedEnvironment(profile.home), tempRoot)
    receipt.browser = edge.evidence; receipt.browserVersion = edge.browser.version()
    page = await edge.context.newPage(); await page.setViewportSize({ width: 1600, height: 1000 })
    native = observeNativeRequests(page) // attach BEFORE navigation opens the resident WebSocket
    page.setDefaultTimeout(15000)
    receipt.pageErrors = 0
    page.on('pageerror', () => { receipt.pageErrors++ })
    await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
    ensure(new URL(page.url()).origin === gateway.origin, 'BROWSER_FOREIGN_ORIGIN')
    await page.waitForFunction(name => window.__DSH_BOOT__?.entries?.some(entry => (entry.id ?? entry.package) === name), receipt.package.name, { timeout: 15000 })
    const entry = await page.evaluate(name => window.__DSH_BOOT__.entries.find(item => (item.id ?? item.package) === name), receipt.package.name)
    const bundle = await page.evaluate(async url => { const response = await fetch(url); const text = await response.text();
      return { status: response.status, closure: text.includes('__ModuleLoader__.load') } }, entry.url)
    ensure(bundle.status === 200 && bundle.closure, 'BROWSER_CLIENT_BUNDLE_MISSING')
    receipt.boot = { authenticated: true, pluginPing: true, clientEntry: receipt.package.name, actualBrowser: true }
    receipt.boot.clientBundle = bundle
    receipt.observer = publicObserverSnapshot(profile.observerFile)
    if (options.mode !== 'readiness') {
      const { inspectSessionCodec } = await import(pathToFileURL(join(PLUGIN, 'src/conversation/contracts.ts')).href)
      await runConversationBrowser({ page, gateway, fixture, profile, root: tempRoot, reportDir: options.reportDir,
        mode: options.mode, receipt, inspectCodec: inspectSessionCodec(), native,
        restartHost: () => restartOwnedHost({ profile, firstHost: host, receipt, mode: options.mode, onBoot: value => { host = value } }) })
      receipt.browserEvidence = true
      receipt.providerEvidence = options.mode === 'live'
    }
    ensure(receipt.pageErrors === 0, 'BROWSER_PAGE_ERROR')
    ensure(host.child.exitCode === null && host.child.signalCode === null, 'HOST_EXITED_DURING_JOURNEY')
    receipt.status = 'passed'
  } catch (error) { receipt.failure = { category: errorCategory(error) }; receipt.status = 'failed' }
  finally {
    native?.stop()
    try { await edge?.close() } catch (error) { receipt.cleanup.failure = errorCategory(error); receipt.status = 'failed' }
    try { await stopHost(host?.child); receipt.cleanup.hostStopped = true } catch (error) { receipt.cleanup.failure = errorCategory(error); receipt.status = 'failed' }
    if (profile && receipt.package) {
      try {
        receipt.package.artifactSha256After = sha256(JSON.stringify(artifactInventory(join(profile.installedPackage, 'lib'))))
        ensure(receipt.package.artifactSha256After === receipt.package.artifactSha256, 'EVIDENCE_INSTALLED_ARTIFACT_CHANGED')
      } catch { receipt.status = 'failed'; receipt.failure = { category: 'EVIDENCE_INSTALLED_ARTIFACT_CHANGED' } }
    }
    if (tempRoot) { try { rmSync(tempRoot, { recursive: true, force: true }); receipt.cleanup.isolationRemoved = true } catch { receipt.cleanup.failure = 'HOST_ISOLATION_CLEANUP_FAILED'; receipt.status = 'failed' } }
    receipt.finishedAt = new Date().toISOString()
    if (captureEvidenceFingerprint) receipt.fingerprintAfter = captureEvidenceFingerprint()
    if (provenance) {
      try { receipt.provenanceAfter = collectorProvenance(options.fixture, provenance.pnpm?.path) } catch { receipt.status = 'failed'; receipt.failure = { category: 'EVIDENCE_PROVENANCE_UNAVAILABLE' } }
      if (!identical(before, receipt.fingerprintAfter) || !identical(provenance, receipt.provenanceAfter)) { receipt.status = 'failed'; receipt.failure = { category: 'EVIDENCE_FINGERPRINT_CHANGED' } }
    }
  }
  const findings = auditArtifacts(options.reportDir)
  if (findings.length) { receipt.status = 'failed'; receipt.secretFindings = findings; receipt.failure = { category: 'SECRET_ARTIFACT_DETECTED' } }
  let gate
  try { gate = validateCollectorGate(receipt, { reportDir: options.reportDir, fingerprint: before, fingerprintAfter: receipt.fingerprintAfter }) }
  catch (error) { gate = { ok: false, category: errorCategory(error) }; receipt.status = 'failed' }
  receipt.gate = gate
  // Secret scan AFTER serialization too, without exposing matches.
  const text = JSON.stringify(receipt, null, 2)
  const { secretCategories } = await import('./conversation-evidence.mjs')
  const categories = secretCategories(text)
  if (categories.length) {
    writeFileSync(join(options.reportDir, 'receipt.json'), JSON.stringify({ planId: PLAN_ID, status: 'failed', failure: { category: 'SECRET_RECEIPT_DETECTED' },
      secretFindings: categories.map(category => ({ path: 'receipt.json', category })), keyRead: false }, null, 2), { mode: 0o600 })
    return { ok: false, category: 'SECRET_RECEIPT_DETECTED', reportDir: options.reportDir }
  }
  writeFileSync(join(options.reportDir, 'receipt.json'), text, { mode: 0o600 })
  writeFileSync(join(options.reportDir, 'collector.log'), `${receipt.status}\n${receipt.failure?.category ?? gate.category ?? 'EVIDENCE_VALIDATED'}\n`, { mode: 0o600 })
  return { ok: gate.ok === true, mode: options.mode, providerEvidence: receipt.providerEvidence && gate.ok === true, reportDir: options.reportDir,
    failure: receipt.failure?.category ?? gate.category ?? null }
}
async function main() {
  let options
  try { options = parseCli(process.argv.slice(2)) } catch (error) { console.error(errorCategory(error)); process.exitCode = 2; return }
  if (options.help) { console.log(HELP); return }
  try { const result = await runCollector(options); console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 1 }
  catch (error) { console.error(errorCategory(error)); process.exitCode = 1 }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
