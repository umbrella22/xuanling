#!/usr/bin/env node
// Real, keyless packed lifecycle via the public DSH CLI. No SDK app launch,
// source mounts, import-only green, inherited credentials or historical reports.
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { captureEvidenceFingerprint, VerificationNotRunError } from '../../../integrations/deepseek-harness/xuanling-blueprint/scripts/verify.mjs'
import { equalEvidenceFingerprint } from '../../../integrations/deepseek-harness/xuanling-blueprint/test/acceptance/evidence-manifest.mjs'
import { LIFECYCLE_BEHAVIOR_FLAGS } from '../../../integrations/deepseek-harness/xuanling-blueprint/test/acceptance/behavior-evidence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROBE = resolve(HERE, '..'), REPO = resolve(PROBE, '..', '..')
const BP = join(REPO, 'integrations', 'deepseek-harness', 'xuanling-blueprint')
const CLI = join(PROBE, 'node_modules', '.bin', 'dsh')
const PACKAGE = '@xuanling-rs/xuanling-dsh-blueprint'
const COMMAND_TIMEOUT_MS = 600_000 // Existing CLI command bound.
const BOOT_TIMEOUT_MS = 180_000 // Existing lifecycle boot bound; no sleep oracle.
const HTTP_TIMEOUT_MS = 15_000
const STOP_GRACE_MS = 5_000
const OUTPUT_LIMIT_BYTES = 1024 * 1024 // Memory bound on untrusted CLI output, never archived.
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const fingerprint = () => captureEvidenceFingerprint({ packageRoot: BP, repoRoot: REPO })

class LifecycleError extends Error {
  constructor(code) { super(`Lifecycle failed (${code})`); this.code = code; this.reason_code = code }
}
const fail = code => { throw new LifecycleError(code) }
const check = (condition, code) => { if (!condition) fail(code) }

function parseOptions(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s)
    if (!['--mode', '--report-dir', '--plan-id'].includes(flag) || Object.hasOwn(options, flag)) fail('LIFECYCLE_OPTIONS_INVALID')
    const value = inline ?? argv[++i]
    if (!value || value.startsWith('--')) fail('LIFECYCLE_OPTIONS_INVALID')
    options[flag] = value
  }
  if (!['web', 'headless'].includes(options['--mode']) || !options['--report-dir']
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(options['--plan-id'] ?? '')) fail('LIFECYCLE_OPTIONS_INVALID')
  return { mode: options['--mode'], reportDir: resolve(options['--report-dir']), planId: options['--plan-id'] }
}

// No environment enumeration, credentials, proxy, NODE_OPTIONS or real configs.
// Registry is the ordinary public npm registry; all config/cache/tool paths are
// owned by this fixture, including npm pack's user/global configuration.
function isolatedEnvironment(temp) {
  const home = join(temp, 'home')
  const env = {
    HOME: home, USERPROFILE: home, DSH_HOME: join(home, 'dsh'),
    XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data'),
    TMPDIR: join(temp, 'tmp'), TMP: join(temp, 'tmp'), TEMP: join(temp, 'tmp'),
    npm_config_userconfig: join(temp, 'empty.npmrc'), npm_config_globalconfig: join(temp, 'empty-global.npmrc'),
    npm_config_cache: join(home, 'npm-cache'), npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', NO_COLOR: '1', DSH_TELEMETRY_DISABLED: '1',
  }
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const path of [home, env.TMPDIR]) mkdirSync(path, { recursive: true })
  writeFileSync(env.npm_config_userconfig, '')
  writeFileSync(env.npm_config_globalconfig, '')
  return env
}

// Map ALL original source/lib bytes, including names so added/deleted files
// cannot hide behind presence checks. Never follow a source symlink.
function sourceLibHashes() {
  const files = {}
  const walk = path => {
    const stat = lstatSync(path)
    check(!stat.isSymbolicLink(), 'LIFECYCLE_SOURCE_SYMLINK')
    if (stat.isDirectory()) {
      for (const item of readdirSync(path).sort()) walk(join(path, item))
    } else if (stat.isFile()) files[path.slice(BP.length + 1).split('\\').join('/')] = sha256(readFileSync(path))
  }
  for (const relative of ['src', 'lib', 'package.json', 'cordis.patch.yml']) walk(join(BP, relative))
  return files
}

function supervised(command, args, options, active) {
  const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  const state = { child, ended: false, result: null, spawnError: false, forced: false }
  child.stdin.on('error', () => { /* a concurrent process exit may close the stop pipe */ })
  let escalation, stop
  state.exited = new Promise(resolveExit => {
    child.once('error', () => { state.spawnError = true })
    child.once('close', (status, signal) => {
      state.ended = true
      state.result = { status, signal }
      clearTimeout(escalation)
      active.delete(state)
      resolveExit(state.result)
    })
  })
  state.signal = signal => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch { /* exit may have won */ }
  }
  state.stop = () => stop ??= (async () => {
    if (!state.ended) {
      if (state.requestStop) state.requestStop()
      else state.signal('SIGTERM')
      escalation = setTimeout(() => { state.forced = true; state.signal('SIGKILL') }, STOP_GRACE_MS)
    }
    await state.exited
  })()
  active.add(state)
  return state
}

async function runCommand(kind, command, args, { cwd, env, active, commands, timeout = COMMAND_TIMEOUT_MS }) {
  const started = new Date().toISOString()
  const state = supervised(command, args, { cwd, env }, active)
  let stdout = '', bytes = 0, overLimit = false, timedOut = false
  state.child.stdout.on('data', chunk => {
    bytes += chunk.length
    if (bytes <= OUTPUT_LIMIT_BYTES) stdout += chunk.toString()
    else { overLimit = true; void state.stop() }
  })
  state.child.stderr.on('data', chunk => {
    bytes += chunk.length
    if (bytes > OUTPUT_LIMIT_BYTES) { overLimit = true; void state.stop() }
  })
  state.child.stdin.end()
  const timer = setTimeout(() => { timedOut = true; void state.stop() }, timeout)
  const result = await state.exited
  clearTimeout(timer)
  const code = timedOut ? 'LIFECYCLE_COMMAND_TIMEOUT' : overLimit ? 'LIFECYCLE_OUTPUT_LIMIT'
    : state.spawnError || result.status !== 0 || result.signal !== null ? 'LIFECYCLE_COMMAND_FAILED' : null
  commands.push({ kind, started, finished: new Date().toISOString(), exit_code: result.status, signal: result.signal, reason_code: code })
  if (code) fail(code)
  return stdout // Internal only; raw stdout/errors never enter artifacts.
}

// Generated observer is operator-owned. It calls only public services and
// events in the REAL CLI profile. No private DSH import and no Agent/provider
// replacement. Public appReady is a readiness fact, not a substitute for ping.
const OBSERVER = `
export const inject = ['appReady', 'pluginManager', 'profileContext', 'agents', 'llm']
export function apply(ctx) {
  const mode = process.env.BP_LIFECYCLE_MODE, phase = process.env.BP_LIFECYCLE_PHASE
  const nonce = process.env.BP_LIFECYCLE_NONCE
  let agentRequests = 0, llmRequests = 0, facts = { ready: false }
  const emit = () => process.stdout.write('BP_LIFECYCLE_FACTS ' + JSON.stringify({
    nonce, mode, phase, pid: process.pid, ...facts, agentRequests, llmRequests,
    noUnexpectedModelRequests: agentRequests === 0 && llmRequests === 0,
  }) + '\\n')
  ctx.on('agent/request', async () => { agentRequests++; emit(); throw new Error('LIFECYCLE_MODEL_REQUEST_FORBIDDEN') })
  ctx.on('llm/stream', async function* () { llmRequests++; emit(); throw new Error('LIFECYCLE_MODEL_REQUEST_FORBIDDEN') })
  // Keep headless's input handle open only for this supervised host lifetime.
  // No task runner or readiness sleep; public appExit owns awaited disposal.
  process.stdin.setEncoding('utf8')
  let input = ''
  const stop = chunk => {
    input += chunk
    const line = input.indexOf('\\n')
    if (line >= 0 && input.slice(0, line) === 'BP_LIFECYCLE_STOP ' + nonce) ctx.get('appExit')?.(0)
    if (input.length > 256) input = ''
  }
  process.stdin.on('data', stop)
  process.stdin.resume()
  ctx.effect(() => () => { facts.disposed = true; emit(); process.stdin.off('data', stop); process.stdin.pause() }, 'lifecycle observer lifetime')
  const cancel = ctx.get('appReady').onReady(() => { void (async () => {
    const blueprint = ctx.get('blueprint')
    const bundles = ctx.get('profileContext').startedBundles
    facts = { ready: true, servicePresent: blueprint !== undefined,
      profileMatched: ctx.get('profileContext').name === process.env.BP_LIFECYCLE_PROFILE,
      bundleSelected: bundles.includes('${PACKAGE}'),
      noHostOrHttp: ['host', 'webServer', 'webRuntime', 'webStartup'].every(key => ctx.get(key) === undefined),
      blueprintPingSucceeded: false, disabled: false, disposed: false }
    if (phase === 'active') {
      const value = await blueprint?.ping()
      facts.blueprintPingSucceeded = value?.status === 'ok' && value.service === '${PACKAGE}'
    } else if (phase === 'disable') {
      const result = await ctx.get('pluginManager').setBundleEnabled('${PACKAGE}', false)
      facts.disabled = result.changed === true && result.enabled === false
        && ['applied', 'restart-required'].includes(result.application)
    } else {
      facts.blueprintAbsent = blueprint === undefined && !facts.bundleSelected
    }
    emit()
  })().catch(() => { facts.observerFailed = true; emit() }) })
  ctx.effect(() => cancel, 'lifecycle readiness subscription')
}
`

function profilePatch(observer, runtimeRoot, mode, withPlugin) {
  const disabled = ['hmr', 'session-log-deepseek', 'session-persistence-jsonl', 'session-telemetry-otel',
    'desktop-product-telemetry', 'product-analytics', 'session-title-llm', 'llm-pi-ai', 'llm-deepseek',
    'llm-deepseek-account', 'deepseek-account']
  if (mode === 'headless') disabled.push('headless-runner')
  return [
    ...disabled.map(id => `- id: ${id}\n  disabled: true`),
    '- id: agent-loop\n  config:\n    agents: []',
    ...(withPlugin ? [`- id: xuanling-blueprint\n  config: ${JSON.stringify({ runtimeRoot, skillRoots: [] })}`] : []),
    `- insert:\n    - id: lifecycle-observer\n      name: ${JSON.stringify(observer)}\n      config: {}`,
    '',
  ].join('\n')
}

function bootProfile(profile, mode, phase, env, cwd, active, observations, commands) {
  const nonce = randomUUID(), started = new Date().toISOString()
  const args = ['--profile', profile, ...(mode === 'web' ? ['--host', '127.0.0.1', '--port', '0', '--no-open'] : [])]
  const state = supervised(CLI, args, { cwd, env: { ...env, BP_LIFECYCLE_MODE: mode, BP_LIFECYCLE_PHASE: phase, BP_LIFECYCLE_NONCE: nonce, BP_LIFECYCLE_PROFILE: profile } }, active)
  // The public appExit service owns disposal on every OS. SIGKILL remains a
  // bounded fallback; no natural/forced exit can count as green without facts.
  state.requestStop = () => state.child.stdin.end(`BP_LIFECYCLE_STOP ${nonce}\n`)
  let stdout = '', urlBuffer = '', authUrl, latest, outputExceeded = false, bytes = 0, recorded = false
  const waiters = new Set()
  const changed = () => { for (const notify of [...waiters]) notify() }
  const parseLine = line => {
    const marker = 'BP_LIFECYCLE_FACTS ', index = line.indexOf(marker)
    if (index < 0) return
    try {
      const item = JSON.parse(line.slice(index + marker.length))
      if (item.nonce === nonce && item.mode === mode && item.phase === phase && item.pid === state.child.pid) latest = item
    } catch { /* only the complete owned JSON line is evidence */ }
    changed()
  }
  const onData = chunk => {
    bytes += chunk.length
    if (bytes > OUTPUT_LIMIT_BYTES) { outputExceeded = true; void state.stop(); changed() }
    urlBuffer = (urlBuffer + chunk.toString()).slice(-16_384)
    for (const match of urlBuffer.matchAll(/https?:\/\/[^\s<>"']+\?token=[A-Za-z0-9._-]+/g)) {
      try {
        const url = new URL(match[0])
        if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '') authUrl = url.href
      } catch { /* never persist/log an auth URL */ }
    }
    changed()
  }
  state.child.stdout.on('data', chunk => {
    onData(chunk)
    stdout += chunk.toString()
    let newline
    while ((newline = stdout.indexOf('\n')) >= 0) { parseLine(stdout.slice(0, newline)); stdout = stdout.slice(newline + 1) }
    if (stdout.length > OUTPUT_LIMIT_BYTES) { outputExceeded = true; void state.stop(); changed() }
  })
  state.child.stderr.on('data', onData)
  void state.exited.then(changed)
  async function waitFor(predicate) {
    return await new Promise((resolveWait, rejectWait) => {
      const finish = error => { clearTimeout(timer); waiters.delete(notify); error ? rejectWait(error) : resolveWait() }
      const notify = () => {
        if (state.ended || state.spawnError) finish(new LifecycleError('LIFECYCLE_BOOT_PROCESS_FAILED'))
        else if (outputExceeded || latest?.observerFailed || latest?.noUnexpectedModelRequests === false) finish(new LifecycleError('LIFECYCLE_OBSERVER_FAILED'))
        else if (predicate()) finish()
      }
      const timer = setTimeout(() => finish(new LifecycleError('LIFECYCLE_BOOT_TIMEOUT')), BOOT_TIMEOUT_MS)
      waiters.add(notify)
      notify()
    })
  }
  return {
    state,
    ready: async () => {
      await waitFor(() => latest?.ready === true && latest.profileMatched === true
        && (mode !== 'web' || phase !== 'active' || authUrl !== undefined))
      if (mode === 'headless') check(latest.noHostOrHttp === true, 'LIFECYCLE_HEADLESS_HOST_UNEXPECTED')
      return { facts: latest, authUrl }
    },
    stop: async () => {
      await state.stop()
      const code = state.spawnError || state.forced || state.result?.status !== 0 || state.result?.signal !== null
        ? 'LIFECYCLE_BOOT_STOP_FAILED'
        : latest?.disposed !== true || latest.noUnexpectedModelRequests !== true ? 'LIFECYCLE_MODEL_REQUEST_UNEXPECTED' : null
      if (!recorded) {
        recorded = true
        // Only known booleans/counts/pid; failed boots are archived too. No raw
        // process output, arbitrary error message, nonce/token/URL/provider body.
        observations.push({ mode, phase, pid: state.child.pid ?? null, ready: latest?.ready === true, disposed: latest?.disposed === true,
          servicePresent: latest?.servicePresent === true, bundleSelected: latest?.bundleSelected === true,
          blueprintPingSucceeded: latest?.blueprintPingSucceeded === true, blueprintAbsent: latest?.blueprintAbsent === true,
          disabled: latest?.disabled === true, noHostOrHttp: latest?.noHostOrHttp === true,
          agentRequests: latest?.agentRequests ?? null, llmRequests: latest?.llmRequests ?? null, noUnexpectedModelRequests: latest?.noUnexpectedModelRequests === true })
        commands.push({ kind: `boot-${phase}`, started, finished: new Date().toISOString(), exit_code: state.result?.status ?? null, signal: state.result?.signal ?? null, reason_code: code })
      }
      if (code) fail(code)
    },
  }
}

async function httpPing(authUrl) {
  try {
    const auth = await fetch(authUrl, { redirect: 'manual', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
    const cookie = (auth.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).join('; ')
    check([302, 303].includes(auth.status) && cookie !== '', 'LIFECYCLE_HTTP_AUTH_FAILED')
    await auth.body?.cancel()
    const url = new URL(authUrl); url.search = ''; url.pathname = '/api/blueprint/ping'
    const response = await fetch(url, {
      method: 'POST', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), redirect: 'error',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'blueprint/ping', payload: { args: {} } }),
    })
    const body = await response.json()
    check(response.status === 200 && body?.result?.ok === true && body.result.value?.status === 'ok'
      && body.result.value.service === PACKAGE, 'LIFECYCLE_HTTP_PING_FAILED')
    return { authenticated: true, status: response.status, blueprintPingSucceeded: true }
  } catch (error) {
    if (error instanceof LifecycleError) throw error
    fail('LIFECYCLE_HTTP_PING_FAILED')
  }
}

async function main(options) {
  const { mode, reportDir, planId } = options
  // Claim only a fresh directory; never overwrite another invocation's receipt.
  if (existsSync(reportDir)) check(lstatSync(reportDir).isDirectory() && readdirSync(reportDir).length === 0, 'LIFECYCLE_REPORT_DIR_NOT_FRESH')
  else mkdirSync(reportDir, { recursive: true })
  const started_at = new Date().toISOString(), before = fingerprint(), active = new Set()
  const report = { schema_version: 1, plan_id: planId, suite: 'lifecycle', scope: mode, mode, repeat: 1,
    started_at, evidence_fingerprint: before, environment: { platform: `${process.platform}/${process.arch}`, node: process.version },
    artifacts: {}, runs: [] }
  const flags = Object.fromEntries(Object.entries(LIFECYCLE_BEHAVIOR_FLAGS).map(([id, names]) => [id, Object.fromEntries(names.map(name => [name, false]))]))
  const commands = [], observations = []
  let temp, runtime, sentinel, sourceBefore, sourceAfter, sentinelBefore, sentinelAfter, failure, currentBoot, signalReceived = false
  const onSignal = () => { signalReceived = true; for (const state of active) void state.stop() }
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal)
  const run = (kind, command, args, extra = {}) => {
    check(!signalReceived, 'LIFECYCLE_INTERRUPTED')
    return runCommand(kind, command, args, { cwd: temp, env: environment, active, commands, ...extra })
  }
  const boot = (profile, phase) => {
    check(!signalReceived, 'LIFECYCLE_INTERRUPTED')
    return bootProfile(profile, mode, phase, environment, temp, active, observations, commands)
  }
  let environment
  try {
    if (!existsSync(CLI) || !existsSync(join(BP, 'lib', 'index.js'))) throw new VerificationNotRunError('LIFECYCLE_HOST_OR_ARTIFACT_MISSING', 'Public DSH CLI and Main-built lib are required')
    temp = mkdtempSync(join(tmpdir(), `bp-lifecycle-${mode}-`))
    environment = isolatedEnvironment(temp)
    runtime = join(temp, 'runtime'); mkdirSync(runtime)
    sentinel = join(runtime, 'lifecycle-sentinel.bin'); writeFileSync(sentinel, randomBytes(128), { mode: 0o600 })
    // Sample before ANY install/boot/remove, including isolated tool install.
    sourceBefore = sourceLibHashes(); sentinelBefore = sha256(readFileSync(sentinel))
    report.artifacts.source_lib_hashes_before = sourceBefore
    report.artifacts.runtime_sentinel_sha256_before = sentinelBefore
    const artifactDir = join(reportDir, 'artifacts'); mkdirSync(artifactDir)
    const packed = JSON.parse(await run('pack', 'npm', ['pack', '--ignore-scripts', '--workspaces=false', '--json', '--pack-destination', artifactDir], { cwd: BP, timeout: 120_000 }))
    check(Array.isArray(packed) && packed.length === 1 && packed[0].name === PACKAGE
      && typeof packed[0].filename === 'string' && basename(packed[0].filename) === packed[0].filename, 'LIFECYCLE_PACK_INVALID')
    const tarball = join(artifactDir, packed[0].filename)
    check(lstatSync(tarball).isFile(), 'LIFECYCLE_PACK_INVALID')
    report.artifacts.tarball = { path: tarball, sha256: sha256(readFileSync(tarball)) }
    flags.PL1.packed = true

    // Public CLI needs pnpm on PATH. Provision only this fixture's tool home;
    // scripts disabled, no shared dependencies/profile or corepack user store.
    const tool = join(temp, 'tools')
    await run('isolated-pnpm', 'npm', ['install', '--prefix', tool, '--ignore-scripts', '--no-audit', '--no-fund', 'pnpm@11.27.1'], { timeout: 300_000 })
    environment.PATH = `${join(tool, 'node_modules', '.bin')}${process.platform === 'win32' ? ';' : ':'}${environment.PATH ?? ''}`
    const profile = `lifecycle-${mode}-${randomUUID()}`
    const profileDir = join(environment.DSH_HOME, 'profiles', profile), manifestPath = join(profileDir, 'package.json')
    const manifest = () => JSON.parse(readFileSync(manifestPath, 'utf8'))
    await run('profile-init', CLI, ['--profile', profile, '--from-default-profile', mode, '--dump-config'])
    const baseline = manifest().dsh?.profile?.bundles
    check(isDeepStrictEqual(baseline, ['@deepseek-ai/dsh-base', mode === 'web' ? '@deepseek-ai/dsh-web-app' : '@deepseek-ai/dsh-headless']), 'LIFECYCLE_PROFILE_INVALID')
    flags.PL2.profileInitialized = true
    report.artifacts.baseline_bundles = [...baseline]
    const observer = join(temp, 'observer.mjs'); writeFileSync(observer, OBSERVER, { mode: 0o600 })
    const patchPath = join(profileDir, 'cordis.patch.yml')
    const configure = withPlugin => writeFileSync(patchPath, profilePatch(observer, runtime, mode, withPlugin), { mode: 0o600 })
    configure(true)
    await run('plugin-install', CLI, ['plugin', '--profile', profile, 'add', tarball, '--ignore-scripts'])
    const installed = join(profileDir, 'node_modules', '@xuanling-rs', 'xuanling-dsh-blueprint')
    check(existsSync(join(installed, 'lib', 'index.js')) && manifest().dependencies?.[PACKAGE] !== undefined, 'LIFECYCLE_INSTALL_INVALID')
    check(isDeepStrictEqual(manifest().dsh?.profile?.bundles, [...baseline, PACKAGE]), 'LIFECYCLE_RECONCILE_INVALID')
    // Verify installed bytes really are the packed current lib, not a source mount.
    check(sha256(readFileSync(join(installed, 'lib', 'index.js'))) === sourceBefore['lib/index.js'], 'LIFECYCLE_INSTALLED_ARTIFACT_MISMATCH')
    flags.PL3.installed = true; flags.PL3.reconciled = true
    const dump = await run('installed-config', CLI, ['--profile', profile, '--dump-config'])
    check(dump.includes(runtime) && dump.includes('runtimeRoot:'), 'LIFECYCLE_RUNTIME_CONFIG_MISSING')
    if (mode === 'headless') check(/id: headless-runner[\s\S]*?disabled: true/.test(dump), 'LIFECYCLE_HEADLESS_RUNNER_ENABLED')
    report.artifacts.runtime_root_configured = true

    currentBoot = boot(profile, 'active')
    const ready = await currentBoot.ready()
    check(ready.facts.servicePresent && ready.facts.bundleSelected && ready.facts.blueprintPingSucceeded, 'LIFECYCLE_PUBLIC_PING_FAILED')
    if (mode === 'web') report.artifacts.http = await httpPing(ready.authUrl)
    await currentBoot.stop(); currentBoot = undefined
    flags.PL4.booted = true; flags.PL4.blueprintPingSucceeded = true

    // No fictional CLI disable subcommand: an actual CLI profile invokes the
    // public manager; then a second CLI boot proves persisted deselection.
    currentBoot = boot(profile, 'disable')
    const disabled = await currentBoot.ready()
    check(disabled.facts.disabled === true && !manifest().dsh?.profile?.bundles.includes(PACKAGE)
      && existsSync(join(installed, 'package.json')), 'LIFECYCLE_DISABLE_FAILED')
    await currentBoot.stop(); currentBoot = undefined
    configure(false)
    currentBoot = boot(profile, 'disabled-check')
    const absent = await currentBoot.ready()
    check(absent.facts.blueprintAbsent === true, 'LIFECYCLE_DISABLED_SERVICE_PRESENT')
    await currentBoot.stop(); currentBoot = undefined
    flags.PL5.disabled = true
    // pnpm remove does not accept add's --ignore-scripts option; the
    // isolated npm_config_ignore_scripts=true still disables lifecycle scripts.
    await run('plugin-uninstall', CLI, ['plugin', '--profile', profile, 'remove', PACKAGE])
    check(!existsSync(installed) && !manifest().dependencies?.[PACKAGE] && !manifest().dsh?.profile?.bundles.includes(PACKAGE), 'LIFECYCLE_UNINSTALL_FAILED')
    flags.PL5.uninstalled = true
    const afterBundles = manifest().dsh?.profile?.bundles
    check(isDeepStrictEqual(afterBundles, baseline), 'LIFECYCLE_BASELINE_CHANGED')
    currentBoot = boot(profile, 'baseline')
    const restored = await currentBoot.ready()
    check(restored.facts.blueprintAbsent === true, 'LIFECYCLE_BASELINE_SERVICE_PRESENT')
    await currentBoot.stop(); currentBoot = undefined
    flags.PL6.baselineBundlesPreserved = true
    report.artifacts.bundles_after = afterBundles
  } catch (error) {
    failure = error instanceof LifecycleError || error instanceof VerificationNotRunError ? error : new LifecycleError('LIFECYCLE_EXECUTION_FAILED')
  } finally {
    // Always join process exit BEFORE sampling after bytes or cleaning fixtures.
    if (currentBoot) {
      try { await currentBoot.stop() } catch (error) { failure ??= error instanceof LifecycleError ? error : new LifecycleError('LIFECYCLE_BOOT_STOP_FAILED') }
    }
    await Promise.all([...active].map(state => state.stop()))
    if (sourceBefore) {
      try { sourceAfter = sourceLibHashes(); flags.PL7.sourceUntouched = isDeepStrictEqual(sourceBefore, sourceAfter) } catch { flags.PL7.sourceUntouched = false }
      try { sentinelAfter = sha256(readFileSync(sentinel)); flags.PL7.runtimeDataUntouched = sentinelBefore === sentinelAfter } catch { flags.PL7.runtimeDataUntouched = false }
      report.artifacts.source_lib_hashes_after = sourceAfter ?? {}
      report.artifacts.runtime_sentinel_sha256_after = sentinelAfter ?? null
    }
    report.artifacts.commands = commands; report.artifacts.observations = observations
    if (temp) rmSync(temp, { recursive: true, force: true })
    process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal)
  }
  if (signalReceived) failure = new LifecycleError('LIFECYCLE_INTERRUPTED')
  const after = fingerprint(), stable = equalEvidenceFingerprint(before, after)
  if (!stable) failure = new LifecycleError('LIFECYCLE_EVIDENCE_STALE')
  const results = Object.entries(flags).map(([id, assertions]) => ({
    id, title: `Real ${mode} packed lifecycle ${id}`, expect: 'pass',
    status: Object.values(assertions).every(value => value === true) ? 'pass' : failure instanceof VerificationNotRunError ? 'not-run' : 'fail',
    detail: { ok: Object.values(assertions).every(value => value === true), mode, artifact_sha256: report.artifacts.tarball?.sha256 ?? null, behavior_assertions: assertions },
  }))
  const passed = failure === undefined && stable && results.every(item => item.status === 'pass')
  const finished_at = new Date().toISOString()
  report.passed = passed; report.clean_acceptance_count = passed ? 1 : 0
  report.evidence_fingerprint_after = after; report.finished_at = finished_at
  if (failure) report.reason_code = failure.reason_code ?? failure.code
  report.runs.push({ index: 1, started: started_at, finished: finished_at, duration_ms: Date.parse(finished_at) - Date.parse(started_at),
    evidence_fingerprint: before, evidence_fingerprint_after: after, passed, clean_acceptance_count: passed ? 1 : 0, results })
  writeFileSync(join(reportDir, `w8.lifecycle-${mode}-report.json`), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ suite: 'lifecycle', mode, passed, reason_code: report.reason_code ?? null, results: results.map(({ id, status }) => ({ id, status })) }))
  return passed ? 0 : 1
}

try { process.exitCode = await main(parseOptions(process.argv.slice(2))) }
catch (error) {
  // Never stringify external error messages/stacks, process output or auth URLs.
  console.error(JSON.stringify({ suite: 'lifecycle', passed: false, reason_code: error instanceof LifecycleError ? error.code : 'LIFECYCLE_EXECUTION_FAILED' }))
  process.exitCode = 2
}
