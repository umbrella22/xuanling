#!/usr/bin/env node
import { supportsDshVersion, DSH_COMPATIBILITY_RANGE } from './dsh-version.mjs'
// W0.2 external capability probe for the DSH blueprint plugin plan
// (plan: docs/plans/dsh-blueprint-plugin-development-plan.md, plan_id dsh-blueprint-plugin-v1).
//
// Proves, against a real @deepseek-ai/dsh runtime installed OUTSIDE any DSH
// workspace and a fully isolated DSH_HOME/HOME:
//   P1  the probe plugin tarball installs into a fresh web profile (E-HOST-ADD)
//   P2  the profile boots (E-HOST-BOOT) and the service activates
//   P3  the client module joins the boot graph and its bundle is served
//   P4  the hand-written typert Remote is claimed by the gateway and callable
//       through the public HTTP carrier, with strict-codec rejection on bad input
//   P5  React/cordis platform singletons (no second copy resolved for the plugin)
//
// Every step writes evidence into the JSON report; a failed required step
// exits non-zero. The probe never touches the default HOME or ~/.dsh.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { redactProbeEvidenceText, stringifyProbeEvidence } from './probe-evidence.mjs'
import { prepareCanvasFixtures } from './canvas-fixtures.mjs'
import { runCanvasJourney, measureCanvasPerformance } from './canvas-journey.mjs'
import { setNativeSettingsLocale } from './native-settings-journey.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BP_ROOT = resolve(HERE, '..')
const REPO = resolve(BP_ROOT, '..', '..')
const DSH_VERSION_TARGET = DSH_COMPATIBILITY_RANGE
export const PROBE_BOOT_ARGS = Object.freeze(['--profile', 'blueprint-web', '--no-open'])

const args = process.argv.slice(2)
const KEEP = args.includes('--keep')
const SKIP_BOOT = args.includes('--skip-boot')
const ONLY = (args.find(a => a.startsWith('--only=')) ?? '').split('=')[1] ?? ''
// --plugin-dir <dir> --expect <probe|blueprint>: mount an arbitrary external
// package instead of the built-in probe-plugin. 'blueprint' asserts the real
// xuanling-blueprint package surface (ping + typed capability-unavailable).
const PLUGIN_DIR_OVERRIDE = (args.find(a => a.startsWith('--plugin-dir=')) ?? '').split('=')[1] ?? ''
const EXPECT = (args.find(a => a.startsWith('--expect=')) ?? '').split('=')[1] ?? 'probe'
const PLUGIN_DIR = PLUGIN_DIR_OVERRIDE || join(HERE, 'probe-plugin')
const PLUGIN_NAME = EXPECT === 'blueprint' ? '@xuanling-rs/xuanling-dsh-blueprint' : '@xuanling-rs/blueprint-probe'
const PANEL_SELECTOR = EXPECT === 'blueprint' ? '[data-bp-canvas="root"]' : '[data-blueprint-probe="panel"]'
const CANVAS_TEST = (args.find(a => a.startsWith('--canvas-test=')) ?? '--canvas-test=browser').slice('--canvas-test='.length)
const PANEL_BUTTON_NAMES = EXPECT === 'blueprint' ? ['XuanLing Blueprint'] : []

// Explicit routing applies to the report, screenshot AND nested security gate.
// Standalone default remains the historical probe route; host H1 always passes
// a fresh takeover directory and never reads that historical report as fallback.
export function probeReportRouting(argv) {
  const option = flag => {
    const inline = argv.find(arg => arg.startsWith(`${flag}=`))
    const index = argv.indexOf(flag)
    if (inline === undefined && index < 0) return undefined
    const value = inline === undefined ? argv[index + 1] : inline.slice(flag.length + 1)
    if (value === undefined || value.trim() === '' || value.startsWith('--')) throw new Error(`${flag} requires a non-empty value`)
    return value
  }
  return {
    reportDir: resolve(option('--report-dir') ?? join(REPO, 'docs', 'validation', 'blueprint', 'current', 'w0')),
    planId: option('--plan-id') ?? 'dsh-blueprint-plugin-v1',
  }
}

export function probeArtifactPaths(reportDir) {
  return { report: join(reportDir, 'w0.2-probe-report.json'), screenshot: join(reportDir, 'w0.2-sidebar.png'), securityDir: join(reportDir, 'tools') }
}

let routing
try { routing = probeReportRouting(args) }
catch (error) { process.stderr.write(redactProbeEvidenceText(`probe: ${error.message}\n`)); process.exit(2) }
const REPORT_DIR = routing.reportDir
const ARTIFACT_PATHS = probeArtifactPaths(REPORT_DIR)

export function publicRpcUnavailable(response) {
  return response?.body?.result?.ok !== true
    && (response?.status === 404 || (response?.body?.result?.ok === false
      && ['gateway/invocation-unavailable', 'gateway/definition-unavailable'].includes(response.body.result.error?.code)))
}

export function rawScriptUnavailable(response, sentinelExists) {
  return sentinelExists === false && publicRpcUnavailable(response)
}

// Admission and durable settlement are separate RPC observations. Each poll
// gets the remaining bounded budget; a missing/malformed response is not green.
export async function waitForTerminal(callApi, runId, { timeoutMs = 15000, pollIntervalMs = 100 } = {}) {
  if (typeof runId !== 'string' || runId === '') throw new Error('startRun produced no valid runId')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) throw new Error('invalid terminal poll budget')
  const deadline = performance.now() + timeoutMs
  const observations = []
  const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out'])
  while (performance.now() < deadline) {
    const remaining = Math.max(1, Math.ceil(deadline - performance.now()))
    const response = await callApi('blueprint/inspectRun', { args: { runId } }, `probe-inspect-${runId}-${observations.length}`, AbortSignal.timeout(remaining))
    observations.push(response)
    const snapshot = response.body?.result?.value
    if (response.body?.result?.ok !== true || snapshot?.runId !== runId) throw new Error('inspectRun failed or returned an unrelated run')
    if (terminal.has(snapshot.state)) return { ...response, observations }
    await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadline - performance.now()))))
  }
  throw new Error(`inspectRun did not settle within ${timeoutMs}ms`)
}

// C-05: cancel of an already successful run is a successful idempotent no-op.
// Inspect after EACH RPC: checking only the final snapshot could hide an
// intermediate mutation that a second cancel happens to undo.
export async function terminalCancelEvidence(callApi, runId, beforeCancel) {
  const baseline = structuredClone(beforeCancel?.body?.result?.value)
  const cancels = []
  const inspections = []
  if (typeof runId !== 'string' || runId === '' || beforeCancel?.status !== 200
    || beforeCancel?.body?.result?.ok !== true || baseline?.runId !== runId || baseline?.state !== 'succeeded'
    || typeof baseline.definitionRevision !== 'string' || baseline.definitionRevision === ''
    || !Number.isInteger(baseline.seq) || baseline.seq < 0 || !Array.isArray(baseline.attempts) || !Array.isArray(baseline.logTail)) {
    return { ok: false, detail: 'cancel no-op requires a complete successful terminal inspect snapshot', baseline, cancels, inspections }
  }
  const violations = []
  for (let i = 1; i <= 2; i++) {
    const cancel = await callApi('blueprint/cancelRun', { args: { runId } }, `probe-cancel-${i}`)
    cancels.push(cancel)
    const value = cancel.body?.result?.value
    if (cancel.status !== 200 || cancel.body?.result?.ok !== true || value?.runId !== runId || value?.state !== baseline.state) {
      violations.push(`cancel ${i} did not return the same successful runId/state`)
    }
    const inspect = await callApi('blueprint/inspectRun', { args: { runId } }, `probe-cancel-inspect-${i}`)
    inspections.push(inspect)
    // Compare the entire public aggregate, not just state: seq/logTail,
    // attempts, revision and any later snapshot fields must all be unchanged.
    if (inspect.status !== 200 || inspect.body?.result?.ok !== true || !isDeepStrictEqual(inspect.body?.result?.value, baseline)) {
      violations.push(`inspect after cancel ${i} changed the terminal aggregate or failed`)
    }
  }
  return { ok: violations.length === 0, detail: violations.join('; ') || 'two successful cancels; both complete inspect snapshots unchanged', baseline, cancels, inspections }
}

const report = {
  probe: 'w0.2-external-capabilities',
  plan_id: routing.planId,
  started_at: new Date().toISOString(),
  dsh_version_target: DSH_VERSION_TARGET,
  environment: {},
  steps: [],
  assertions: [],
  artifacts: {},
  passed: false,
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

function log(message) {
  process.stdout.write(redactProbeEvidenceText(`[probe] ${message}\n`))
}

function assert(id, description, passed, detail) {
  report.assertions.push({ id, description, passed, detail })
  log(`${passed ? 'PASS' : 'FAIL'} ${id}: ${description}${detail ? ` — ${detail}` : ''}`)
  return passed
}

function step(id, name) {
  const entry = { id, name, started_at: new Date().toISOString() }
  report.steps.push(entry)
  log(`step ${id}: ${name}`)
  return {
    done(extra) {
      entry.finished_at = new Date().toISOString()
      Object.assign(entry, extra)
    },
  }
}

function run(cmd, cmdArgs, options = {}) {
  const res = spawnSync(cmd, cmdArgs, {
    encoding: 'utf8',
    timeout: options.timeout ?? 300_000,
    env: options.env,
    cwd: options.cwd,
  })
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error?.message,
  }
}

// Do not inherit real provider credentials, proxy/auth tokens, NODE_OPTIONS,
// DSH profile or npm configuration. Operational PATH/locale/temp are sufficient.
export function isolatedProbeEnv(home, source = process.env) {
  const env = {}
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT']) {
    if (source[key] !== undefined) env[key] = source[key]
  }
  return {
    ...env,
    DSH_HOME: join(home, 'dsh'), HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, 'xdg-config'), XDG_CACHE_HOME: join(home, 'xdg-cache'), XDG_DATA_HOME: join(home, 'xdg-data'),
    npm_config_cache: join(home, 'npm-cache'), npm_config_userconfig: join(home, '.npmrc'), npm_config_globalconfig: join(home, 'global.npmrc'),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', NO_COLOR: '1',
  }
}
const ISOLATED_ENV = isolatedProbeEnv

// Browser OS integration needs the operator's normal home (not a synthetic
// macOS keychain location). Playwright still owns a fresh temporary userDataDir;
// only HOME/USERPROFILE change here, never the credential environment allowlist.
export function probeBrowserEnv(home, source = process.env) {
  const originalHome = source.HOME || source.USERPROFILE
  if (typeof originalHome !== 'string' || originalHome.trim() === '') throw new Error('BROWSER_HOME_UNAVAILABLE: HOME or USERPROFILE is required for browser launch')
  return { ...isolatedProbeEnv(home, source), HOME: originalHome, USERPROFILE: source.USERPROFILE || originalHome }
}

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'xuanling-bp-probe-'))
  mkdirSync(REPORT_DIR, { recursive: true })
  const home = join(tempRoot, 'isolated-home')
  const cwd = join(tempRoot, 'cwd')
  const homeDsh = join(home, 'dsh')
  const profileDir = join(homeDsh, 'profiles', 'blueprint-web')
  const profileJson = join(profileDir, 'package.json')
  for (const dir of [tempRoot, home, cwd]) mkdirSync(dir, { recursive: true })
  report.environment.temp_root = tempRoot
  report.environment.node = process.version
  report.environment.platform = `${process.platform}/${process.arch}`
  log(`temp root: ${tempRoot}`)

  // S0: locate and verify the installed dsh CLI version.
  const s0 = step('S0', 'verify installed dsh CLI version')
  const dshBin = join(BP_ROOT, 'node_modules', '.bin', 'dsh')
  if (!existsSync(dshBin)) {
    s0.done({ status: 'failed', error: 'dsh CLI not found; run npm install in test/blueprint' })
    finalize(1)
    return
  }
  const version = run(dshBin, ['--version'], { env: ISOLATED_ENV(home), cwd })
  report.environment.dsh_version_output = version.stdout.trim()
  const s0ok = assert('P0', `dsh CLI satisfies ${DSH_VERSION_TARGET}`, version.status === 0 && supportsDshVersion(version.stdout.trim()), version.stdout.trim() || version.stderr.trim())
  s0.done({ status: s0ok ? 'passed' : 'failed' })
  if (!s0ok) {
    finalize(1)
    return
  }

  // S1: pack the probe plugin tarball.
  const s1 = step('S1', 'pack probe plugin tarball')
  const pack = run('npm', ['pack', '--pack-destination', tempRoot], { cwd: PLUGIN_DIR, env: ISOLATED_ENV(home) })
  const tarballName = pack.stdout.trim().split('\n').pop()
  const tarball = join(tempRoot, tarballName ?? '')
  const packOk = assert('P1a', 'npm pack produced a tarball', pack.status === 0 && tarballName && existsSync(tarball), `${pack.status} ${redactProbeEvidenceText(pack.stderr).slice(0, 300)}`)
  if (packOk) {
    report.artifacts.tarball = { path: tarball, sha256: sha256(readFileSync(tarball)) }
    report.artifacts.plugin_source = {}
    for (const f of ['package.json', 'cordis.patch.yml', 'src/index.ts', 'src/typert.host.ts', 'src/client/index.ts', 'lib/index.js', 'lib/typert.host.js', 'lib/client.js']) {
      const full = join(PLUGIN_DIR, f)
      if (existsSync(full)) report.artifacts.plugin_source[f] = sha256(readFileSync(full))
    }
  }
  s1.done({ status: packOk ? 'passed' : 'failed' })
  if (!packOk) {
    finalize(1)
    return
  }

  const env = ISOLATED_ENV(home)

  let fixtures
  if (EXPECT === 'blueprint') {
    if (!['browser', 'performance'].includes(CANVAS_TEST)) throw new Error('unsupported canvas-test mode')
    const definition = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'definition.js')).href)
    fixtures = prepareCanvasFixtures(tempRoot, definition.decodeDefinition, definition.validateDefinition)
    report.artifacts.canvas_fixtures = fixtures.evidence
    report.environment.canvas_test = CANVAS_TEST
    report.environment.node = process.version
    report.environment.platform = `${process.platform}/${process.arch}`
  }

  // S2p: pnpm provisioning. The corepack shim bundled with Node 24 resolves
  // pnpm 12 (no packageManager pin in the published @deepseek-ai/dsh manifest)
  // but expects bin/pnpm.cjs, which pnpm 12 no longer ships — the shim aborts
  // with MODULE_NOT_FOUND. Provision a standalone pnpm 11 on PATH instead so
  // the profile's plugin install runs without corepack. Recorded as U01
  // evidence: an installable combo needs pnpm <12 on PATH (or an equivalent
  // pin) on this Node corepack.
  if (!ONLY || ONLY === 'add' || ONLY === 'boot') {
    const s2p = step('S2p', 'provision standalone pnpm (bypass corepack shim incompatibility)')
    const pnpmTool = join(tempRoot, 'pnpm-tool')
    const pnpmInstall = run('npm', ['install', '--prefix', pnpmTool, '--no-audit', '--no-fund', 'pnpm@11.27.1'], { env, cwd: tempRoot, timeout: 300_000 })
    const toolBin = join(pnpmTool, 'node_modules', '.bin')
    env.PATH = `${toolBin}:${env.PATH ?? process.env.PATH}`
    const pnpmCheck = run('pnpm', ['--version'], { env, cwd: tempRoot })
    const pnpmOk = assert('P2p', 'standalone pnpm 11.27.1 resolves on the probe PATH', pnpmInstall.status === 0 && pnpmCheck.stdout.trim() === '11.27.1', `install=${pnpmInstall.status} pnpm=${pnpmCheck.stdout.trim() || redactProbeEvidenceText(pnpmCheck.stderr).slice(0, 200)}`)
    report.environment.pnpm_provisioning = { strategy: 'standalone-11.27.1-on-path', corepack_shim_incompatible: true }
    s2p.done({ status: pnpmOk ? 'passed' : 'failed' })
    if (!pnpmOk) {
      finalize(1)
      return
    }
  }

  // S2: initialize a fresh web profile from the shipped template (E-HOST-INIT).
  if (!ONLY || ONLY === 'init' || ONLY === 'boot') {
    const s2 = step('S2', 'E-HOST-INIT: create blueprint-web profile from default web template')
    const init = run(dshBin, ['--profile', 'blueprint-web', '--from-default-profile', 'web', '--dump-config'], { env, cwd, timeout: 600_000 })
    const initOk = assert('P2a', 'profile init exits 0 and creates the profile manifest', init.status === 0 && existsSync(profileJson), `exit=${init.status} ${redactProbeEvidenceText(init.stderr).slice(0, 400)}`)
    if (initOk) {
      const manifest = JSON.parse(readFileSync(profileJson, 'utf8'))
      report.artifacts.profile_manifest = manifest
      assert('P2b', 'profile manifest lists the web template bundles', Array.isArray(manifest.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.includes('@deepseek-ai/dsh-web-app'), JSON.stringify(manifest.dsh?.profile?.bundles))
    } else {
      report.artifacts.init_output = { stdout: redactProbeEvidenceText(init.stdout).slice(0, 4000), stderr: redactProbeEvidenceText(init.stderr).slice(0, 4000) }
    }
    s2.done({ status: initOk ? 'passed' : 'failed' })
    if (!initOk) {
      finalize(1)
      return
    }
  }

  // Mount the generated canvas fixtures through the profile's ordinary
  // operator patch layer. The probe owns only this isolated config; it does
  // not add diagnostic or direct MCP execution components.
  if (fixtures && (!ONLY || ONLY === 'boot' || ONLY === 'add')) {
    const profilePatch = join(profileDir, 'cordis.patch.yml')
    const patchYaml = [
      '- insert:',
      '    - id: xuanling-blueprint',
      "      name: '@xuanling-rs/xuanling-dsh-blueprint'",
      `      config: ${JSON.stringify(fixtures.config)}`,
      '',
    ].join('\n')
    const prior = existsSync(profilePatch) ? readFileSync(profilePatch, 'utf8') : ''
    const merged = /^\s*\[\s*\]\s*$/m.test(prior)
      ? prior.replace(/^\s*\[\s*\]\s*$/m, patchYaml.trimEnd())
      : `${prior}${prior.endsWith('\n') || prior === '' ? '' : '\n'}${patchYaml}`
    writeFileSync(profilePatch, merged)
  }

  // S3: install the tarball into the profile (E-HOST-ADD).
  if (!ONLY || ONLY === 'add' || ONLY === 'boot') {
    const s3 = step('S3', 'E-HOST-ADD: install probe tarball into blueprint-web profile')
    const add = run(dshBin, ['plugin', '--profile', 'blueprint-web', 'add', tarball], { env, cwd, timeout: 600_000 })
    report.artifacts.add_output = { status: add.status, stdout: redactProbeEvidenceText(add.stdout).slice(-4000), stderr: redactProbeEvidenceText(add.stderr).slice(-4000) }
    const rel = PLUGIN_NAME.split('/')
    const installedPath = join(profileDir, 'node_modules', rel[0], rel[1], 'package.json')
    const addOk = assert('P3a', 'plugin add exits 0 and the package is present in the profile', add.status === 0 && existsSync(installedPath), `exit=${add.status} ${redactProbeEvidenceText(add.stderr).slice(0, 400)}`)
    if (addOk) {
      const manifest = JSON.parse(readFileSync(profileJson, 'utf8'))
      assert('P3b', 'profile manifest reconciled the bundle into dsh.profile.bundles', manifest.dsh?.profile?.bundles?.includes(PLUGIN_NAME), JSON.stringify(manifest.dsh?.profile?.bundles))
    }
    s3.done({ status: addOk ? 'passed' : 'failed' })
    if (!addOk) {
      finalize(1)
      return
    }
  }

  // S4: platform singleton inventory (cordis / react copies reachable by the plugin).
  if (!ONLY || ONLY === 'singletons') {
    const s4 = step('S4', 'platform singleton inventory')
    const countCopies = (root, segments) => {
      if (!existsSync(root)) return 0
      const res = spawnSync('find', [root, '-type', 'd', '-path', `*${segments.join('/')}*`, '-maxdepth', '6'], { encoding: 'utf8' })
      return res.stdout.trim() ? res.stdout.trim().split('\n').filter(p => p.endsWith(segments.join('/'))).length : 0
    }
    const profileNm = join(profileDir, 'node_modules')
    const installNm = join(BP_ROOT, 'node_modules')
    const cordisInProfile = countCopies(profileNm, ['@deepseek-ai', 'cordis'])
    const reactInProfile = countCopies(profileNm, ['react'])
    report.environment.singleton_inventory = { cordis_in_profile: cordisInProfile, react_in_profile: reactInProfile, install_root: installNm }
    assert('P5a', 'exactly one @deepseek-ai/cordis instance is visible in the profile tree', cordisInProfile <= 1, `count=${cordisInProfile}`)
    assert('P5b', 'no react copy is vendored into the profile for the probe plugin', reactInProfile === 0, `count=${reactInProfile}`)
    s4.done({ status: 'passed' })
  }

  if (SKIP_BOOT) {
    finalize(report.assertions.every(a => a.passed) ? 0 : 1)
    return
  }

  // S5: boot the profile (E-HOST-BOOT) and verify serving surfaces.
  const s5 = step('S5', 'E-HOST-BOOT: boot blueprint-web and verify plugin surfaces')
  const boot = spawn(dshBin, PROBE_BOOT_ARGS, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let bootLog = ''
  let baseUrl = null
  const bootPromise = new Promise((resolveBoot) => {
    const timer = setTimeout(() => resolveBoot('timeout'), 180_000)
    const onData = (chunk) => {
      bootLog += chunk
      const match = bootLog.match(/https?:\/\/[^\s]+token=[A-Za-z0-9._-]+/)
      if (match && !baseUrl) {
        baseUrl = match[0]
        clearTimeout(timer)
        resolveBoot('ready')
      }
    }
    boot.stdout.on('data', onData)
    boot.stderr.on('data', onData)
    boot.on('exit', (code) => {
      clearTimeout(timer)
      resolveBoot(`exited:${code}`)
    })
  })
  const bootResult = await bootPromise
  report.artifacts.boot_log_tail = redactProbeEvidenceText(bootLog).slice(-6000)
  if (bootResult !== 'ready') {
    assert('P4a', 'web profile boots and prints its authenticated URL', false, `result=${bootResult}`)
    s5.done({ status: 'failed' })
    finalize(1)
    return
  }
  assert('P4a', 'web profile boots and prints its authenticated URL', true, baseUrl)
  report.environment.base_url = redactProbeEvidenceText(baseUrl)

  // Give the server a moment to finish binding after printing the URL.
  await new Promise(r => setTimeout(r, 3000))

  let httpOk = true
  try {
    // Authenticate: GET /?token=mints a session cookie via 303 (redirect must
    // stay manual so undici does not drop the intermediate set-cookie).
    const authRes = await fetch(baseUrl, { redirect: 'manual' })
    const cookies = (authRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ')
    report.artifacts.auth_status = authRes.status
    report.artifacts.auth_cookie_set = cookies !== ''
    const authHeaders = cookies ? { cookie: cookies } : {}
    const page = await fetch(new URL('./', baseUrl), { headers: authHeaders, redirect: 'follow' })
    const pageBody = await page.text()
    report.artifacts.index_status = page.status
    report.artifacts.index_has_boot = pageBody.includes('__DSH_BOOT__')
    report.artifacts.index_bytes = pageBody.length
    httpOk &= assert('P4b', 'authenticated page serves the client shell with a boot manifest', page.status === 200 && pageBody.includes('__DSH_BOOT__'), `status=${page.status} cookie=${cookies !== ''}`)

    // The /api carrier validates a connection-RPC envelope: the payload is
    // { args } and the method must equal the endpoint (rpc-schema.ts).
    const apiBase = baseUrl.split('?')[0].replace(/\/$/, '')
    if (EXPECT === 'blueprint') {
      const callApi = async (method, wireArgs, rpcId, signal = AbortSignal.timeout(15000)) => {
        const res = await fetch(`${apiBase}/api/${method}`, {
          signal, method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders },
          body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: wireArgs } }),
        })
        return { status: res.status, body: await res.json().catch(() => null) }
      }
      const ping = await callApi('blueprint/ping', {}, 'probe-ping-1')
      report.artifacts.blueprint_ping = { status: ping.status, body: ping.body }
      httpOk &= assert('P4f', 'blueprint ping returns build metadata through the gateway',
        ping.status === 200 && ping.body?.result?.ok === true && ping.body?.result?.value?.status === 'ok',
        stringifyProbeEvidence(ping.body, 0)?.slice(0, 240))
      // The blueprint validate descriptor declares one wire parameter named
      // 'args' (the ValidateArgs object), so the wire args record is
      // { args: { definitionJson } }.
      // W4.3 command service: validate + full run lifecycle through the gateway.
      const validate = await callApi('blueprint/validate', { args: { definitionJson: '{}' } }, 'probe-validate-1')
      report.artifacts.blueprint_validate = { status: validate.status, body: validate.body }
      httpOk &= assert('P4g', 'validate rejects a bad definition with typed blueprint/definition-invalid',
        validate.body?.result?.ok === false && validate.body?.result?.error?.code === 'blueprint/definition-invalid',
        stringifyProbeEvidence(validate.body, 0)?.slice(0, 240))

      const loaded = await callApi('blueprint/loadDefinition', { args: { blueprintId: 'probe-lifecycle' } }, 'probe-load-lifecycle')
      const document = loaded.body?.result?.value
      httpOk &= assert('P4x', 'configured ID resolves a document with document/semantic/layout revisions, never a browser path',
        loaded.status === 200 && loaded.body?.result?.ok === true && document?.blueprintId === 'probe-lifecycle'
        && ['documentRevision', 'semanticRevision', 'layoutRevision'].every(key => typeof document[key] === 'string')
        && !JSON.stringify(document).includes(tempRoot), 'configured probe-lifecycle document')
      const definitionObj = JSON.parse(document.definitionJson)
      const startArgs = (inputJson, requestId) => ({ args: { blueprintId: 'probe-lifecycle', expectedRevision: document.documentRevision, inputJson, requestId } })
      const okDef = JSON.stringify(definitionObj)
      const valid = await callApi('blueprint/validate', { args: { definitionJson: okDef } }, 'probe-validate-2')
      const start1 = await callApi('blueprint/startRun', startArgs('{"request":"probe request one"}', 'probe-req-1'), 'probe-start-1')
      report.artifacts.blueprint_start1 = { status: start1.status, body: start1.body }
      const run1 = start1.body?.result?.value
      const start2 = await callApi('blueprint/startRun', startArgs('{"request":"probe request one"}', 'probe-req-1'), 'probe-start-2')
      const run2 = start2.body?.result?.value
      const inspect = await waitForTerminal(callApi, run1?.runId)
      report.artifacts.blueprint_inspect = { status: inspect.status, body: inspect.body, observations: inspect.observations }
      const inspected = inspect.body?.result?.value
      httpOk &= assert('P4m', 'startRun admits a valid graph; bounded inspectRun polling observes its durable successful terminal',
        valid.body?.result?.ok === true && typeof valid.body?.result?.value?.semanticRevision === 'string'
        && start1.body?.result?.ok === true && typeof run1?.runId === 'string'
        && inspect.body?.result?.ok === true && inspected?.runId === run1?.runId && inspected?.state === 'succeeded'
        && Array.isArray(inspected?.attempts) && inspected.attempts.length === 2,
        stringifyProbeEvidence(inspect.body, 0)?.slice(0, 300))
      httpOk &= assert('P4n', 'duplicate startRun with the same requestId replays the same run (idempotent admission)',
        run2?.runId === run1?.runId && run2?.replayed === true,
        `${run1?.runId} vs ${run2?.runId} replayed=${run2?.replayed}`)
      const start3 = await callApi('blueprint/startRun', startArgs('{"request":"probe request two"}', 'probe-req-2'), 'probe-start-3')
      const run3 = start3.body?.result?.value
      const beforeCancel = await waitForTerminal(callApi, run3?.runId)
      report.artifacts.blueprint_before_cancel = beforeCancel
      const cancellation = await terminalCancelEvidence(callApi, run3?.runId, beforeCancel)
      report.artifacts.blueprint_cancel = cancellation.cancels[0] ?? null
      report.artifacts.blueprint_cancel_idempotency = cancellation
      httpOk &= assert('P4o', 'two cancelRun RPCs on a succeeded run succeed with identical runId/state and leave each complete inspect snapshot unchanged',
        cancellation.ok, cancellation.detail)
      const missing = await callApi('blueprint/inspectRun', { args: { runId: 'run-does-not-exist' } }, 'probe-inspect-2')
      const missingCancel = await callApi('blueprint/cancelRun', { args: { runId: 'run-does-not-exist' } }, 'probe-cancel-missing')
      report.artifacts.blueprint_missing_run = { inspect: missing, cancel: missingCancel }
      httpOk &= assert('P4p', 'inspectRun and cancelRun on an unknown run fail typed blueprint/run-not-found',
        missing.body?.result?.ok === false && missing.body?.result?.error?.code === 'blueprint/run-not-found'
        && missingCancel.body?.result?.ok === false && missingCancel.body?.result?.error?.code === 'blueprint/run-not-found',
        stringifyProbeEvidence(report.artifacts.blueprint_missing_run, 0)?.slice(0, 300))

      // Export bytes over the wire, then import into the SAME configured ID's
      // emptied disposable root. Never rewrite the archive ID or use real data.
      const bpDir = join(fixtures.config.workspaceRoot, '.xuanling', 'workflows', 'probe-portable')
      const beforePackage = { definition: readFileSync(join(bpDir, 'blueprint.json')), agent: readFileSync(join(bpDir, 'lib', 'agents', 'a.md')) }
      const exp = await callApi('blueprint/exportDefinition', { args: { blueprintId: 'probe-portable' } }, 'probe-export-1')
      report.artifacts.blueprint_export = exp
      const expValue = exp.body?.result?.value
      const archive = typeof expValue?.archiveBase64 === 'string' ? Buffer.from(expValue.archiveBase64, 'base64') : null
      httpOk &= assert('P4q', 'exportDefinition materializes the closure and delivers verified portable archive bytes (no outPath)',
        exp.body?.result?.ok === true && expValue?.blueprintId === 'probe-portable' && expValue?.files >= 2
        && typeof expValue?.closureDigest === 'string' && archive?.length > 0 && sha256(archive) === expValue?.archiveSha256
        && !Object.hasOwn(expValue, 'archivePath') && !archive?.includes(Buffer.from(tempRoot)), 'base64 + sha256 + closure digest')
      renameSync(bpDir, join(tempRoot, 'portable-source-backup'))
      mkdirSync(bpDir)
      const impArgs = { args: { blueprintId: 'probe-portable', archiveBase64: expValue?.archiveBase64 } }
      const imp = await callApi('blueprint/importDefinition', impArgs, 'probe-import-1')
      report.artifacts.blueprint_import = imp
      const impValue = imp.body?.result?.value
      const importedOk = imp.body?.result?.ok === true && impValue?.blueprintId === 'probe-portable'
        && impValue?.closureDigest === expValue?.closureDigest && impValue?.filesWritten >= 2
        && existsSync(join(bpDir, 'blueprint.json')) && existsSync(join(bpDir, 'lib', 'agents', 'a.md'))
        && isDeepStrictEqual(JSON.parse(readFileSync(join(bpDir, 'blueprint.json'), 'utf8')), JSON.parse(beforePackage.definition.toString()))
        && readFileSync(join(bpDir, 'lib', 'agents', 'a.md')).equals(beforePackage.agent)
      httpOk &= assert('P4r', 'importDefinition republishes the same closure atomically into the configured empty ID root (digest and bytes identical)', importedOk, 'configured same-ID archive round trip')
      const beforeAgain = importedOk ? { definition: sha256(readFileSync(join(bpDir, 'blueprint.json'))), agent: sha256(readFileSync(join(bpDir, 'lib', 'agents', 'a.md'))) } : null
      const impAgain = await callApi('blueprint/importDefinition', impArgs, 'probe-import-2')
      httpOk &= assert('P4s', 'importDefinition refuses a nonempty configured target typed, leaving the existing closure unchanged',
        impAgain.body?.result?.ok === false && impAgain.body?.result?.error?.code === 'blueprint/import-failed' && beforeAgain !== null
        && sha256(readFileSync(join(bpDir, 'blueprint.json'))) === beforeAgain.definition
        && sha256(readFileSync(join(bpDir, 'lib', 'agents', 'a.md'))) === beforeAgain.agent, 'no partial import or overwrite')

      // Diagnostic probes are intentionally absent from the production wire.
      // Their old direct execution path could bypass durable Run admission and
      // intent-before-effect. Assert the public surface is unavailable instead
      // of restoring an unsafe compatibility endpoint.
      const removedHostProbe = await callApi('blueprint/hostProbe', { args: { blueprintId: 'probe-skill', resourceId: 'probe', input: 'removed' } }, 'probe-host-removed')
      const removedMcpProbe = await callApi('blueprint/mcpProbe', { args: { serverName: 'probe', toolName: 'removed', args: {} } }, 'probe-mcp-removed')
      report.artifacts.removed_diagnostic_probes = {
        hostProbe: removedHostProbe,
        mcpProbe: removedMcpProbe,
      }
      httpOk &= assert('P4h', 'hostProbe is unavailable on the public wire and cannot execute an unrecorded agent effect',
        publicRpcUnavailable(removedHostProbe), stringifyProbeEvidence(removedHostProbe.body, 0)?.slice(0, 300))
      httpOk &= assert('P4i', 'mcpProbe is unavailable on the public wire and cannot execute an unrecorded MCP effect',
        publicRpcUnavailable(removedMcpProbe), stringifyProbeEvidence(removedMcpProbe.body, 0)?.slice(0, 300))

      // The authenticated raw-script diagnostic must be uncallable. A harmless
      // sentinel proves absence of body execution; this is not anonymous RCE.
      const rawSentinel = join(tempRoot, 'forbidden-raw-script.txt')
      const rawScript = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(rawSentinel)}, 'harmless sentinel')`
      const forbidden = await callApi('blueprint/toolProbe', { args: { scriptContent: rawScript, mcpBindingId: 'repo-readonly' } }, 'probe-raw-script-denied')
      report.artifacts.raw_script_denial = { status: forbidden.status, body: forbidden.body, sentinelExists: existsSync(rawSentinel) }
      httpOk &= assert('P4j-raw', 'authenticated raw toolProbe RPC is unavailable and produces no script side effect',
        rawScriptUnavailable(forbidden, existsSync(rawSentinel)), stringifyProbeEvidence(report.artifacts.raw_script_denial, 0)?.slice(0, 300))

      // Success/failed/guard/cancel/timeout evidence moved off the removed RPC:
      // the built production adapter is registered with REAL DSH ToolRuntime,
      // and every test enters tools.execute (including the real timeout policy).
      mkdirSync(ARTIFACT_PATHS.securityDir, { recursive: true })
      const securityReportPath = join(ARTIFACT_PATHS.securityDir, 'w2.security-report.json')
      rmSync(securityReportPath, { force: true }) // never accept a stale report
      const security = run(process.execPath, [join(PLUGIN_DIR, 'scripts', 'verify.mjs'),
        '--suite', 'security', '--scope', 'host', '--report-dir', ARTIFACT_PATHS.securityDir,
        '--plan-id', routing.planId], { cwd: PLUGIN_DIR, env: ISOLATED_ENV(home), timeout: 60000 })
      const securityReport = existsSync(securityReportPath) ? JSON.parse(readFileSync(securityReportPath, 'utf8')) : null
      report.artifacts.host_tools_contract = { status: security.status, reportPath: securityReportPath, report: securityReport, stderr: redactProbeEvidenceText(security.stderr).slice(-2000) }
      const hostCase = id => security.status === 0 && securityReport?.passed === true && securityReport?.plan_id === routing.planId
        && securityReport?.runs?.length === 1 && securityReport.runs[0].results.some(result => result.id === id && result.status === 'pass')
      httpOk &= assert('P4j', 'registered frozen script succeeds via real tools.execute; real host guard prevents denied side effects',
        hostCase('HOST-SCRIPT-ALLOW') && hostCase('HOST-SCRIPT-DENY') && hostCase('T16-H1'), securityReportPath)
      httpOk &= assert('P4k', 'real tools.execute and DSH timeout policy stop the script; failed/timeout are never host success or auto-retry',
        hostCase('HOST-SCRIPT-TIMEOUT') && hostCase('HOST-SCRIPT-INTERNAL-TIMEOUT') && hostCase('HOST-SCRIPT-FAILED') && hostCase('T16-H2'), securityReportPath)
      httpOk &= assert('P4w', 'real tools.execute cancellation drains started script, pre-abort starts nothing, temp/process/listeners are released',
        hostCase('HOST-SCRIPT-CANCEL') && hostCase('HOST-SCRIPT-PREABORT'), securityReportPath)
    } else {
      const echoRes = await fetch(`${apiBase}/api/blueprintProbe/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'probe-echo-1',
          method: 'blueprintProbe/echo',
          payload: { args: { message: 'w0-probe' } },
        }),
      })
      const echoBody = await echoRes.json().catch(() => null)
      report.artifacts.echo_response = { status: echoRes.status, body: echoBody }
      const echoOk = echoRes.status === 200
        && echoBody?.type === 'server-response'
        && echoBody?.result?.ok === true
        && echoBody?.result?.value?.message === 'probe-echo:w0-probe'
      httpOk &= assert('P4d', 'typed Remote echo returns the probe marker through the gateway', echoOk, stringifyProbeEvidence(echoBody, 0)?.slice(0, 300))

      const badRes = await fetch(`${apiBase}/api/blueprintProbe/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'probe-echo-2',
          method: 'blueprintProbe/echo',
          payload: { args: { message: 12345 } },
        }),
      })
      const badBody = await badRes.json().catch(() => null)
      report.artifacts.echo_invalid_response = { status: badRes.status, body: badBody }
      const badOk = badRes.status === 200
        && badBody?.result?.ok === false
        && typeof badBody?.result?.error?.code === 'string'
      httpOk &= assert('P4e', 'strict codec rejects a wrongly typed argument with a typed error', badOk, `status=${badRes.status} ${stringifyProbeEvidence(badBody, 0)?.slice(0, 300)}`)
    }
  } catch (error) {
    httpOk = false
    report.artifacts.http_error = String(error)
    assert('P4b', 'HTTP surface reachable', false, String(error))
  }
  s5.done({ status: httpOk ? 'passed' : 'failed' })

  // S6: browser-level boot graph check via Playwright + system Edge (best effort).
  const s6 = step('S6', 'browser boot-graph and sidebar check (Playwright, msedge channel)')
  let browserTried = false
  try {
    const pw = await import('playwright')
    browserTried = true
    const browser = await pw.chromium.launch({ channel: 'msedge', headless: true, env: probeBrowserEnv(home) })
    report.environment.browser_version = browser.version()
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' })
    page.setDefaultTimeout(15000)
    const consoleMessages = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleMessages.push(msg.text()) })
    await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 60_000 })
    await page.waitForTimeout(3000)
    const bootEntries = await page.evaluate(() => {
      const boot = window.__DSH_BOOT__
      if (!boot) return null
      return (boot.entries ?? []).map(e => ({ id: e.id ?? e.package ?? null, url: e.url ?? null }))
    })
    report.artifacts.boot_entries = bootEntries
    const probeEntry = Array.isArray(bootEntries) ? bootEntries.find(e => String(e.id ?? '').includes(PLUGIN_NAME.split('/')[1])) : null
    assert('P6a', 'browser boot graph contains the probe client module', Boolean(probeEntry), stringifyProbeEvidence(bootEntries, 0)?.slice(0, 400))

    // Fetch the served bundle in the authenticated page context (the single
    // entry route requires the server-computed rev query from the graph).
    if (probeEntry?.url) {
      const bundleCheck = await page.evaluate(async (url) => {
        const res = await fetch(url)
        const body = res.status === 200 ? await res.text() : ''
        return { status: res.status, closure: body.includes('__ModuleLoader__.load'), bytes: body.length }
      }, probeEntry.url)
      report.artifacts.client_bundle = bundleCheck
      assert('P4c2', 'probe client bundle is served in closure-factory format', bundleCheck.status === 200 && bundleCheck.closure, JSON.stringify(bundleCheck))
    } else {
      assert('P4c2', 'probe client bundle is served in closure-factory format', false, 'probe entry url missing from boot graph')
    }

    // Dismiss only by hit-tested user input. An occluding host modal is a gate
    // failure, not permission to remove DOM masks or el.click around it.
    const { dismissOnboardingDialogs } = await import('./onboarding-journey.mjs')
    await dismissOnboardingDialogs(page)
    if (EXPECT === 'blueprint') await setNativeSettingsLocale(page, 'en')
    for (const name of PANEL_BUTTON_NAMES) await page.getByRole('button', { name, exact: true }).click()
    await page.locator(PANEL_SELECTOR).waitFor({ state: 'visible', timeout: 15000 })
    assert('P6b', 'blueprint panel renders in the live page after real pointer sidebar activation', await page.locator(PANEL_SELECTOR).isVisible(), 'DSH boot graph mounted panel')
    if (EXPECT === 'blueprint') {
      const apiForCanvas = async (method, value) => {
        const response = await page.request.post(`${baseUrl.split('?')[0].replace(/\/$/, '')}/api/blueprint/${method}`, {
          data: { type: 'client-request', rpcId: `canvas-${method}-${crypto.randomUUID()}`, method: `blueprint/${method}`, payload: { args: { args: value } } },
        })
        return { status: response.status(), body: await response.json() }
      }
      if (CANVAS_TEST === 'performance') report.artifacts.canvas_performance = await measureCanvasPerformance(page, assert, fixtures.evidence.find(f => f.id === 'canvas-performance'), apiForCanvas)
      else report.artifacts.canvas_journey = await runCanvasJourney(page, assert, apiForCanvas)
    }
    const probeErrors = consoleMessages.filter(m => m.toLowerCase().includes('probe') || m.toLowerCase().includes('blueprint'))
    assert('P6c', 'no console errors mentioning the probe module', probeErrors.length === 0, probeErrors.slice(0, 3).join(' | '))
    report.artifacts.browser_console_errors = consoleMessages.slice(0, 20)
    await page.screenshot({ path: ARTIFACT_PATHS.screenshot, fullPage: false })
    report.artifacts.sidebar_screenshot = ARTIFACT_PATHS.screenshot
    await browser.close()
    s6.done({ status: 'passed' })
  } catch (error) {
    report.artifacts.browser_error = String(error)
    s6.done({ status: browserTried ? 'failed' : 'not_run', error: String(error) })
    // A browser-block exception must never look like a clean run: record it
    // as a failed assertion so the probe cannot report a vacuous pass.
    if (browserTried) assert('P6z', 'browser interaction block completed without exceptions', false, redactProbeEvidenceText(String(error)).slice(0, 220))
    else assert('P6z', 'required real mounted browser is available (absence is not a pass)', false, 'playwright unavailable; not-run')
  }

  boot.kill('SIGTERM')
  const exitCode = report.assertions.every(a => a.passed) ? 0 : 1
  if (KEEP) log(`temp root kept: ${tempRoot}`)
  else rmSync(tempRoot, { recursive: true, force: true })
  finalize(exitCode)
}

function finalize(exitCode) {
  report.finished_at = new Date().toISOString()
  report.passed = report.assertions.length > 0 && report.assertions.every(a => a.passed)
  mkdirSync(REPORT_DIR, { recursive: true })
  const reportPath = ARTIFACT_PATHS.report
  writeFileSync(reportPath, stringifyProbeEvidence(report))
  log(`report written: ${reportPath}`)
  log(`probe ${report.passed ? 'PASSED' : 'FAILED'} (${report.assertions.filter(a => a.passed).length}/${report.assertions.length} assertions)`)
  process.exit(exitCode)
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  main().catch((error) => {
    log(`fatal: ${error?.stack ?? error}`)
    finalize(1)
  })
}
