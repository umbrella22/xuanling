import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { VerificationNotRunError } from '../../scripts/verify.mjs'
import { LiveJourneyError, collectLiveFailureEvidence } from './live-diagnostic-evidence.mjs'
import { builtinConfiguration, validateBuiltinConfiguration } from './builtin-provider-configuration.mjs'
export { LiveJourneyError } from './live-diagnostic-evidence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE = '@xuanling-rs/xuanling-dsh-blueprint'
const PROTOCOLS = Object.freeze({
  'openai-completions': 'openai-completions', openai_chat_completions: 'openai-completions',
  'openai-responses': 'openai-responses', openai_responses: 'openai-responses',
  'anthropic-messages': 'anthropic-messages', anthropic_messages: 'anthropic-messages',
})
const digest = value => createHash('sha256').update(value).digest('hex')
const fail = code => { throw new LiveJourneyError(code) }

export function configuration(env, NotRun = VerificationNotRunError) {
  if (env.BP_LIVE_BUILTIN_PROVIDER !== undefined) return builtinConfiguration(env, NotRun)
  for (const name of ['BP_LIVE_PROVIDER_KEY', 'BP_LIVE_PROVIDER_BASE_URL', 'BP_LIVE_PROVIDER_MODEL']) {
    if (typeof env[name] !== 'string' || env[name].trim() === '') throw new NotRun('LIVE_CONFIGURATION_MISSING', 'live provider configuration absent; required BP_LIVE_PROVIDER_KEY/BASE_URL/MODEL')
  }
  const protocol = PROTOCOLS[env.BP_LIVE_PROVIDER_PROTOCOL ?? 'openai-completions']
  if (!protocol) fail('LIVE_PROTOCOL_UNSUPPORTED')
  let endpoint
  try { endpoint = new URL(env.BP_LIVE_PROVIDER_BASE_URL) } catch { fail('LIVE_ENDPOINT_INVALID') }
  // A loopback fixture can test failures, never satisfy the live gate. No auth URL.
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) fail('LIVE_ENDPOINT_INVALID')
  if (['localhost', '::1', '[::1]'].includes(endpoint.hostname) || /^(127\.|0\.|169\.254\.)/.test(endpoint.hostname)) fail('LIVE_SYNTHETIC_ENDPOINT')
  if (/^(placeholder|synthetic|test[-_]|fake[-_])/i.test(env.BP_LIVE_PROVIDER_KEY)) fail('LIVE_SYNTHETIC_CREDENTIAL')
  return { key: env.BP_LIVE_PROVIDER_KEY, baseUrl: endpoint.href.replace(/\/$/, ''), model: env.BP_LIVE_PROVIDER_MODEL, protocol }
}

export function revalidateConfiguration(config) {
  if (config?.provider !== undefined) return validateBuiltinConfiguration(config, VerificationNotRunError)
  return configuration({ BP_LIVE_PROVIDER_KEY: config?.key, BP_LIVE_PROVIDER_BASE_URL: config?.baseUrl,
    BP_LIVE_PROVIDER_MODEL: config?.model, BP_LIVE_PROVIDER_PROTOCOL: config?.protocol })
}

export function isolatedEnvironment(home, config, source = process.env) {
  const route = config.provider === undefined ? {
    BP_LIVE_PROVIDER_BASE_URL: config.baseUrl, BP_LIVE_PROVIDER_PROTOCOL: config.protocol,
  } : { BP_LIVE_BUILTIN_PROVIDER: validateBuiltinConfiguration(config, VerificationNotRunError).provider }
  const env = {}
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT']) if (source[key] !== undefined) env[key] = source[key]
  return { ...env, HOME: home, USERPROFILE: home, DSH_HOME: join(home, 'dsh'),
    XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data'),
    TMPDIR: join(home, 'tmp'), TMP: join(home, 'tmp'), TEMP: join(home, 'tmp'),
    NO_COLOR: '1', DSH_TELEMETRY_MODE: 'OFF',
    BP_LIVE_PROVIDER_KEY: config.key, BP_LIVE_PROVIDER_MODEL: config.model, ...route }
}

// The diagnostic preload is opt-in, after isolation. Ambient Node options and
// any ambient budget report path are never inherited by a normal journey.
export function isolatedJourneyEnvironment(home, config, diagnosticBudget, source = process.env) {
  const env = isolatedEnvironment(home, config, source)
  if (diagnosticBudget !== undefined) {
    const { preloadPath, reportPath } = diagnosticBudget ?? {}
    if (typeof preloadPath !== 'string' || !isAbsolute(preloadPath) || typeof reportPath !== 'string' || !isAbsolute(reportPath)) throw new TypeError('invalid diagnostic budget paths')
    env.NODE_OPTIONS = '--import ' + pathToFileURL(preloadPath).href
    env.BP_LIVE_DIAGNOSTIC_BUDGET_FILE = reportPath
  }
  return env
}

// The idle watchdog includes the first async-iterator demand, which can load
// a protocol implementation lazily before sending HTTP. A hanging loopback
// fixture waits for that public module to be ready before its 100ms budget
// starts. Ordinary and live collectors keep their exact observer source.
export function withFixtureProviderReadiness(source, protocol, { negativeOnly = false, fixtureProviderIdleTimeoutMs } = {}) {
  if (fixtureProviderIdleTimeoutMs === undefined) return source
  if (!negativeOnly || !Number.isSafeInteger(fixtureProviderIdleTimeoutMs) || fixtureProviderIdleTimeoutMs <= 0
    || fixtureProviderIdleTimeoutMs > 2147483647 || !Object.values(PROTOCOLS).includes(protocol)) fail('LIVE_SYNTHETIC_FIXTURE_INVALID')
  return `await import(${JSON.stringify(`@earendil-works/pi-ai/api/${protocol}`)})\n${source}`
}

export function profilePatch({ blueprintRoot, runtimeRoot, observerModule, toolIds = [], liveConfig, fixtureProviderIdleTimeoutMs }) {
  const provider = liveConfig?.provider === undefined ? 'blueprint-live'
    : validateBuiltinConfiguration(liveConfig, VerificationNotRunError).provider
  const disabled = new Set(['llm-deepseek', 'llm-deepseek-account', 'deepseek-account', 'session-log-deepseek', 'session-persistence-jsonl', 'session-telemetry-otel', 'desktop-product-telemetry', 'product-analytics', 'session-title-llm', 'hmr', 'preset-ptc', 'preset-minimal', 'preset-cordis', 'agent-instructions', 'skill-filesystem', ...toolIds])
  return [
    ...[...disabled].map(id => `- id: ${id}\n  disabled: true`),
    '- id: preset-standard\n  config:\n    id: standard\n    order: 1\n    plugins: []',
    '- id: agent-loop\n  config:\n    agents: []',
    "- id: system-prompt\n  config:\n    personaPrefix: ''\n    personaSuffix: ''",
    provider !== 'blueprint-live'
      ? `- id: llm-pi-ai\n  config:\n    providers:\n      ${provider}:\n        apiKeyEnv: BP_LIVE_PROVIDER_KEY`
      : `- id: llm-pi-ai\n  config:\n    providers:\n      blueprint-live:\n        apiKeyEnv: BP_LIVE_PROVIDER_KEY\n        api: !!js process.env.BP_LIVE_PROVIDER_PROTOCOL\n        baseURL: !!js process.env.BP_LIVE_PROVIDER_BASE_URL\n        streamIdleTimeoutMs: ${fixtureProviderIdleTimeoutMs ?? 30000}\n        models:\n          - id: !!js process.env.BP_LIVE_PROVIDER_MODEL\n            input: [text]\n            reasoningEfforts: false\n            contextWindow: 32768\n            maxTokens: 256`,
    ...fixtureProviderIdleTimeoutMs === undefined ? [] : ['- id: llm-retry\n  disabled: true'],
    `- id: agent-default-model\n  config:\n    provider: ${provider}\n    model: !!js process.env.BP_LIVE_PROVIDER_MODEL`,
    `- id: xuanling-blueprint\n  config: ${JSON.stringify({ blueprints: { 'live-journey': blueprintRoot }, runtimeRoot, skillRoots: [] })}`,
    `- insert:\n    - id: blueprint-live-observer\n      name: ${JSON.stringify(observerModule)}\n      config: {}`,
    '',
  ].join('\n')
}

export function createBlueprint(root) {
  mkdirSync(join(root, 'lib', 'agents'), { recursive: true })
  writeFileSync(join(root, 'lib', 'agents', 'echo.md'), 'Reply ONLY with the exact nonce supplied in the input JSON, without commentary. Do not use tools.\n')
  const definition = { schemaVersion: 1, id: 'live-journey', name: 'C11 live nonce journey', resources: { echo: { kind: 'agent', path: 'lib/agents/echo.md' } }, graph: {
    nodes: [{ id: 'model', kind: 'agentTask', agentRef: 'echo', outputs: { text: 'string' } }, { id: 'downstream', kind: 'output', inputs: { text: 'string' }, outputs: { text: 'string' } }],
    edges: [{ kind: 'data', from: 'model.text', to: 'downstream.text' }],
  } }
  writeFileSync(join(root, 'blueprint.json'), JSON.stringify(definition))
}

// The only HTTP transport in this harness is to the authenticated LOOPBACK DSH
// gateway. Providers are reached exclusively by DSH AgentLoop's public adapter.
export function makeGateway(authUrl) {
  const url = new URL(authUrl)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) fail('LIVE_GATEWAY_NOT_LOCAL')
  let cookie = ''
  return {
    async authenticate() {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
      cookie = (response.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).join('; ')
      if (!cookie || ![302, 303].includes(response.status)) fail('LIVE_GATEWAY_AUTH_FAILED')
    },
    async call(method, args) {
      if (!['blueprint/ping', 'blueprint/loadDefinition', 'blueprint/startRun', 'blueprint/inspectRun', 'blueprint/cancelRun'].includes(method)) fail('LIVE_GATEWAY_METHOD_INVALID')
      const target = new URL(`/api/${method}`, url.origin)
      const response = await fetch(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) })
      const body = await response.json()
      if (response.status !== 200 || body?.result?.ok !== true) fail('LIVE_GATEWAY_RPC_FAILED')
      return body.result.value
    },
  }
}

function boot(cli, profile, env, cwd) {
  const child = spawn(cli, ['--profile', profile, '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  // Keep only a bounded in-memory tail to discover the local auth URL; never
  // forward stdout/stderr, print errors, persist a boot log or archive the URL.
  const ready = new Promise((resolveReady, reject) => {
    let tail = ''
    const timer = setTimeout(() => reject(new LiveJourneyError('LIVE_HOST_BOOT_TIMEOUT')), 30000)
    const take = chunk => {
      tail = (tail + chunk.toString()).slice(-8192)
      const match = tail.match(/http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/[^\s]*token=[A-Za-z0-9._-]+/)
      if (match) { clearTimeout(timer); resolveReady(match[0]); tail = '' }
    }
    child.stdout.on('data', take); child.stderr.on('data', take)
    child.once('error', () => { clearTimeout(timer); reject(new LiveJourneyError('LIVE_HOST_BOOT_FAILED')) })
    child.once('exit', () => { clearTimeout(timer); reject(new LiveJourneyError('LIVE_HOST_EXITED')) })
  })
  return { child, ready }
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise(resolveStop => {
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 5000)
    child.once('exit', () => { clearTimeout(timer); resolveStop() })
    child.kill('SIGTERM')
  })
}

// recovery_required stops observation as a typed failure, not a success or a
// terminal claim. timed_out is the production Run timeout terminal.
export function isRunObservationComplete(state) {
  return ['succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_required'].includes(state)
}

// Only known state vocabulary, formal IDs, and output digests leave memory.
export function safeRunSnapshot(snapshot) {
  const state = value => ['queued', 'ready', 'running', 'waiting_input', 'cancelling', 'succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_required', 'skipped'].includes(value) ? value : 'unknown'
  const id = value => typeof value === 'string' && /^(run-|att-)[a-zA-Z0-9-]{1,100}$/.test(value) ? value : null
  const kind = value => ['succeeded', 'provider-failed', 'failed', 'timeout', 'cancelled', 'recovery_required'].includes(value) ? value : null
  return { runId: id(snapshot?.runId), state: state(snapshot?.state), attempts: (snapshot?.attempts ?? []).map(item => ({
    attemptId: id(item.attemptId), nodeId: ['model', 'downstream'].includes(item.nodeId) ? item.nodeId : null,
    state: state(item.state), resultKind: kind(item.resultKind),
    output_sha256: typeof item.outputJson === 'string' ? digest(item.outputJson) : null,
  })) }
}

export function assertJourney(snapshot, observed, nonce) {
  if (snapshot?.state !== 'succeeded') {
    const failures = observed?.sessions?.map(item => item.runtimeFailure) ?? []
    if (failures.includes('MODEL_ROUTE_MISSING')) fail('LIVE_MODEL_ROUTE_MISSING')
    if (failures.includes('PROMPT_MODEL_MISSING')) fail('LIVE_PROMPT_MODEL_MISSING')
    const kinds = snapshot?.attempts?.map(item => item.resultKind) ?? []
    fail(kinds.includes('timeout') ? 'LIVE_PROVIDER_TIMEOUT' : kinds.includes('provider-failed') ? 'LIVE_PROVIDER_FAILED' : 'LIVE_RUN_NOT_SUCCEEDED')
  }
  const attempt = snapshot.attempts?.find(item => item.nodeId === 'model')
  const downstream = snapshot.attempts?.find(item => item.nodeId === 'downstream')
  const output = item => { try { return JSON.parse(item?.outputJson).outputs?.text } catch { return undefined } }
  const text = output(attempt)
  if (attempt?.state !== 'succeeded' || attempt.resultKind !== 'succeeded' || typeof text !== 'string' || text.trim() !== nonce) fail('LIVE_AGENT_NONCE_MISSING')
  if (downstream?.state !== 'succeeded' || downstream.resultKind !== 'succeeded' || output(downstream) !== text) fail('LIVE_DOWNSTREAM_NONCE_MISSING')
  // New Attempts own the execution identity; only legacy snapshots lack it.
  const facts = observed.sessions?.find(item => attempt.sessionId !== undefined
    ? item.sessionId === attempt.sessionId
    : item.sessionId.startsWith(`bp-${snapshot.runId}-${attempt.attemptId}-`))
  if (!facts || !['agentCreated', 'inboxSeen', 'scopedAgentSeen', 'requestSeen', 'loopRequestSeen', 'responseSeen', 'completed', 'disposed'].every(name => facts[name] === true)) fail('LIVE_AGENT_FACTS_MISSING')
  return { runId: snapshot.runId, attemptId: attempt.attemptId, downstreamAttemptId: downstream.attemptId, sessionId: facts.sessionId,
    runSucceeded: true, agentCreated: true, inboxSeen: true, scopedAgentSeen: true, requestSeen: true, loopRequestSeen: true, responseSeen: true, completed: true, disposed: true, nonceMatched: true, downstreamMatched: true, output_sha256: digest(text), nonce_sha256: digest(nonce) }
}

export async function runIsolatedJourney(helpers, config, { negativeOnly = false, diagnosticBudget, fixtureProviderIdleTimeoutMs } = {}) {
  let temp, child, gateway, runId, safeObserved, observerFile, snapshot, observed
  let stage = 'initial', observedFromFile = false
  try {
    if (fixtureProviderIdleTimeoutMs !== undefined && (!negativeOnly || !Number.isSafeInteger(fixtureProviderIdleTimeoutMs)
      || fixtureProviderIdleTimeoutMs <= 0 || fixtureProviderIdleTimeoutMs > 2147483647)) fail('LIVE_SYNTHETIC_FIXTURE_INVALID')
    // Even direct callers cannot promote a loopback fixture into live success.
    if (!negativeOnly) config = revalidateConfiguration(config)
    else {
      let url
      try { url = new URL(config.baseUrl) } catch { fail('LIVE_SYNTHETIC_FIXTURE_INVALID') }
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || config.key !== 'synthetic-W4-do-not-archive' || !Object.values(PROTOCOLS).includes(config.protocol)) fail('LIVE_SYNTHETIC_FIXTURE_INVALID')
    }
    stage = 'configuration_validated'
    const { packageRoot, repoRoot } = helpers
    const cli = join(repoRoot, 'test', 'blueprint', 'node_modules', '.bin', 'dsh')
    if (!existsSync(cli) || !existsSync(join(packageRoot, 'lib', 'index.js'))) throw new VerificationNotRunError('LIVE_HOST_OR_ARTIFACT_MISSING', 'live requires installed public DSH and an existing Main-built plugin')
    stage = 'artifacts_checked'
    temp = mkdtempSync(join(tmpdir(), 'blueprint-live-'))
    const home = join(temp, 'home'), cwd = join(temp, 'cwd'), profile = `bp-live-${randomUUID()}`
    const dir = join(home, 'dsh', 'profiles', profile), bp = join(temp, 'blueprint'), runtime = join(temp, 'runtime')
    for (const path of [dir, cwd, join(home, 'tmp'), join(dir, 'node_modules', '@xuanling-rs'), runtime]) mkdirSync(path, { recursive: true })
    createBlueprint(bp)
    // Public profile manifest + existing built bundle; no npm install/pack/build,
    // no user profile read and no mutation of either checkout's dependencies.
    symlinkSync(resolve(packageRoot), join(dir, 'node_modules', '@xuanling-rs', 'xuanling-dsh-blueprint'), 'dir')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: profile, private: true, type: 'module', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', PACKAGE] } } }))
    const nm = join(repoRoot, 'test', 'blueprint', 'node_modules', '@deepseek-ai')
    const toolIds = []
    for (const bundle of ['dsh-base', 'dsh-web-app']) {
      const yaml = readFileSync(join(nm, bundle, 'cordis.patch.yml'), 'utf8')
      for (const match of yaml.matchAll(/id: (tool-[\w-]+)/g)) toolIds.push(match[1])
    }
    // The observer's only bare import is a public package resolved by the
    // profile's supported runtime resolution, not a DSH private source import.
    symlinkSync(join(repoRoot, 'test', 'blueprint', 'node_modules'), join(temp, 'node_modules'), 'dir')
    const observer = join(temp, 'observer.mjs')
    writeFileSync(observer, withFixtureProviderReadiness(readFileSync(join(HERE, 'observer.mjs'), 'utf8'), config.protocol,
      { negativeOnly, fixtureProviderIdleTimeoutMs }))
    observerFile = join(temp, 'observer-facts.json')
    writeFileSync(join(dir, 'cordis.patch.yml'), profilePatch({ blueprintRoot: bp, runtimeRoot: runtime, observerModule: observer, toolIds, liveConfig: config, fixtureProviderIdleTimeoutMs }), { mode: 0o600 })
    stage = 'profile_prepared'
    const env = isolatedJourneyEnvironment(home, config, diagnosticBudget)
    env.BP_LIVE_OBSERVER_FILE = observerFile
    const host = boot(cli, profile, env, cwd); child = host.child
    stage = 'host_launch_requested'
    gateway = makeGateway(await host.ready)
    stage = 'gateway_ready'
    await gateway.authenticate()
    stage = 'gateway_authenticated'
    const ping = await gateway.call('blueprint/ping', {})
    if (ping?.status !== 'ok' || ping.service !== PACKAGE) fail('LIVE_PLUGIN_NOT_MOUNTED')
    stage = 'plugin_verified'
    const definition = await gateway.call('blueprint/loadDefinition', { args: { blueprintId: 'live-journey' } })
    stage = 'definition_loaded'
    const nonce = `bp-live-${randomUUID()}`
    const started = await gateway.call('blueprint/startRun', { args: { blueprintId: 'live-journey', expectedRevision: definition.documentRevision, inputJson: JSON.stringify({ nonce }), requestId: randomUUID() } })
    runId = started.runId
    if (typeof runId !== 'string' || started.replayed !== false) fail('LIVE_RUN_ADMISSION_INVALID')
    stage = 'run_admitted'
    // This collector stops observing after 30s. Execution timeouts come from
    // the DSH provider profile; Blueprint has no private total deadline.
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      snapshot = await gateway.call('blueprint/inspectRun', { args: { runId } })
      stage = 'run_observed'
      if (isRunObservationComplete(snapshot.state)) break
      await new Promise(resolvePoll => setTimeout(resolvePoll, 50))
    }
    const hasObserverFile = existsSync(observerFile)
    observed = hasObserverFile ? JSON.parse(readFileSync(observerFile, 'utf8')) : { sessions: [] }
    observedFromFile = hasObserverFile
    if (observedFromFile) stage = 'observer_read'
    if (negativeOnly) safeObserved = { ...observed, run_snapshot: safeRunSnapshot(snapshot) }
    if (!snapshot || !isRunObservationComplete(snapshot.state)) fail('LIVE_RUN_OBSERVATION_TIMEOUT')
    const facts = assertJourney(snapshot, observed, nonce)
    stage = 'journey_verified'
    if (negativeOnly) {
      safeObserved.behavior_assertions = facts
      fail('LIVE_SYNTHETIC_SUCCESS_REJECTED')
    }
    return { ok: true, detail: 'formal Run + scoped AgentLoop + downstream nonce verified', behavior_assertions: facts, plan_id: helpers.planId, evidence_fingerprint: helpers.evidenceFingerprint }
  } catch (error) {
    // Whitelist only our typed codes; never stringify a provider/HTTP/OS error
    // (including cause/stack/body/endpoint/key) into runner-visible evidence.
    const failure = error instanceof LiveJourneyError || error instanceof VerificationNotRunError ? error : new LiveJourneyError('LIVE_JOURNEY_FAILED')
    if (negativeOnly) {
      if ((error instanceof LiveJourneyError || error instanceof VerificationNotRunError) && safeObserved) failure.synthetic_evidence = safeObserved
    } else if (failure instanceof LiveJourneyError) {
      // Capture before cancel/stop/rm. A failed read cannot replace the original
      // classification, and neither snapshot nor observer raw data is retained.
      let failureObserved = observedFromFile ? observed : undefined
      if (observerFile) {
        try { if (existsSync(observerFile)) failureObserved = JSON.parse(readFileSync(observerFile, 'utf8')) } catch { /* unavailable facts, no raw error */ }
      }
      failure.failure_evidence = collectLiveFailureEvidence({ stage, snapshot, observed: failureObserved })
    }
    throw failure
  } finally {
    if (gateway && runId) { try { await gateway.call('blueprint/cancelRun', { args: { runId } }) } catch { /* no raw failure evidence */ } }
    await stop(child)
    if (temp) rmSync(temp, { recursive: true, force: true })
  }
}
