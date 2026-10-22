// G-RC-LIVE: a separate structured journey, NOT a replacement for ordinary G-LIVE.
// Importing this module only defines pure observer/oracle helpers; it never boots
// DSH, reads credentials, or contacts a provider. CLI config is environment-only.
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir, platform, arch, release } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { configuration, revalidateConfiguration, isolatedJourneyEnvironment, profilePatch, makeGateway, isRunObservationComplete } from './journey.mjs'
import { builtinModel, isBuiltinProvider, BUILTIN_CONFIGURATION_ERROR_CODES } from './builtin-provider-configuration.mjs'
import { VerificationNotRunError, captureEvidenceFingerprint } from '../../scripts/verify.mjs'

const PLAN = 'dsh-blueprint-runtime-contracts-v1'
const PACKAGE = '@xuanling-rs/xuanling-dsh-blueprint'
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const REPO_ROOT = resolve(PACKAGE_ROOT, '../../..')
const OBSERVATION_MS = 30000 // Collector observation budget; execution follows DSH configuration.
const CODES = new Set([
  ...BUILTIN_CONFIGURATION_ERROR_CODES,
  'STRUCTURED_CLI_INVALID',
  'STRUCTURED_LIVE_FAILED',
  'STRUCTURED_OBSERVER_FAILED',
  'STRUCTURED_HOST_BOOT_TIMEOUT',
  'STRUCTURED_HOST_BOOT_FAILED',
  'STRUCTURED_HOST_EXITED',
  'STRUCTURED_PLUGIN_NOT_MOUNTED',
  'STRUCTURED_RUN_ADMISSION_INVALID',
  'STRUCTURED_OBSERVATION_TIMEOUT',
  'STRUCTURED_RUN_NOT_SUCCEEDED',
  'STRUCTURED_ATTEMPT_MISSING',
  'STRUCTURED_SAVED_REVISION_MISMATCH',
  'STRUCTURED_DIAGNOSTICS_UNAVAILABLE',
  'STRUCTURED_ACCEPTANCE_MISMATCH',
  'STRUCTURED_MODEL_MISMATCH',
  'STRUCTURED_SCHEMA_DIGEST_MISMATCH',
  'STRUCTURED_AGENT_DIGEST_MISMATCH',
  'STRUCTURED_INPUT_DIGEST_MISMATCH',
  'STRUCTURED_TOOL_POLICY_MISMATCH',
  'STRUCTURED_OUTPUT_MISMATCH',
  'STRUCTURED_DOWNSTREAM_MISMATCH',
  'STRUCTURED_AGENT_FACTS_MISSING',
  'STRUCTURED_MARKER_MISSING',
  'STRUCTURED_AUTHORITY_MISSING',
  'STRUCTURED_NONCE_MISMATCH',
  'STRUCTURED_TERMINAL_INCOMPLETE',
  'STRUCTURED_FINGERPRINT_CHANGED',
  'LIVE_PROTOCOL_UNSUPPORTED',
  'LIVE_ENDPOINT_INVALID',
  'LIVE_SYNTHETIC_ENDPOINT',
  'LIVE_SYNTHETIC_CREDENTIAL',
  'LIVE_GATEWAY_NOT_LOCAL',
  'LIVE_GATEWAY_AUTH_FAILED',
  'LIVE_GATEWAY_METHOD_INVALID',
  'LIVE_GATEWAY_RPC_FAILED'
])
const NOT_RUN_CODES = new Set(['LIVE_CONFIGURATION_MISSING', 'LIVE_HOST_OR_ARTIFACT_MISSING', 'STRUCTURED_DSH_UNAVAILABLE'])
export const sha256 = value => createHash('sha256').update(value).digest('hex')
export class StructuredLiveError extends Error {
  constructor(code) {
    const fixed = CODES.has(code) ? code : 'STRUCTURED_LIVE_FAILED'
    super(fixed)
    this.name = 'StructuredLiveError'
    this.code = fixed
  }
}
const fail = code => {
  throw new StructuredLiveError(code)
}

/** Observe public events without substituting Agent, tools, streams or capture.
 * This function is serialized verbatim into a temporary observer module. The
 * marker predicate comes from the INSTALLED public DSH package instance. The
 * original options identity and stream chunks are never cloned/replaced.
 * The observer only audits successful final tools/result notifications. The
 * production structured adapter remains the sole owner of actual capture.
 */
export function createStructuredObserver(ctx, { nonce, isAgentLoopRequest, hash, flush = () => {} }) {
  const agents = new WeakMap()
  const sessions = []
  const snapshot = () => ({ sessions: sessions.map(item => ({ ...item.facts })) })
  const publish = () => flush(snapshot())
  const record = agent => agent && agents.get(agent)
  const exactNonce = value =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, 'nonce') &&
    value.nonce === nonce
  ctx.on('agent/created', ({ agent }) => {
    // Parse only this executor's generated identity, then archive only hashes.
    const match = /^bp-(run-[a-z0-9-]+)-(att-[a-z0-9-]+)-[a-f0-9]{8}$/.exec(agent.id)
    if (!match || agents.has(agent)) return
    const item = {
      eligible: false,
      pending: undefined,
      facts: {
        run_sha256: hash(match[1]),
        attempt_sha256: hash(match[2]),
        agentCreated: true,
        inboxSeen: false,
        scopedAgentSeen: false,
        requestSeen: false,
        requestAborted: false,
        lastStreamMarked: false,
        request_provider_sha256: null,
        request_model_sha256: null,
        markedRequestCount: 0,
        textDeltaCount: 0,
        structuredResultCount: 0,
        authoritativeResultCount: 0,
        parentCommitCount: 0,
        nonceMismatch: false,
        runtimeErrorSeen: false,
        completed: false,
        disposed: false
      }
    }
    agents.set(agent, item)
    sessions.push(item)
    publish()
  })
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    const item = record(agent)
    if (!item) return
    item.facts.inboxSeen = true
    item.facts.scopedAgentSeen ||=
      agent.ctx !== ctx && !!agent.ctx?.tools && message.content.some(block => block.type === 'text' && block.text.startsWith('[blueprint agent]'))
    publish()
  })
  ctx.on('agent/request', async ({ agent, signal }, next) => {
    const item = record(agent)
    if (item) {
      item.facts.requestSeen = true
      const aborted = () => {
        item.eligible = false
        item.facts.lastStreamMarked = false
        item.facts.requestAborted = true
        publish()
      }
      if (signal.aborted) aborted()
      else signal.addEventListener('abort', aborted, { once: true })
      publish()
    }
    return await next()
  })
  ctx.on('agent/error', ({ agent }) => {
    const item = record(agent)
    if (!item) return
    item.eligible = false
    item.facts.runtimeErrorSeen = true
    publish()
  })
  ctx.on('llm/stream', async function* (options, next) {
    const agent = ctx.get('agents')?.currentInitiator()
    const item = record(agent)
    const marked = !!item && isAgentLoopRequest(options) && options.sessionId === agent.id
    if (item) {
      // A prior marked request cannot authorize a later unmarked stream.
      item.eligible = false
      item.facts.lastStreamMarked = marked
      if (marked) {
        item.facts.markedRequestCount++
        item.facts.request_provider_sha256 = typeof options.provider === 'string' ? hash(options.provider) : null
        item.facts.request_model_sha256 = typeof options.model === 'string' ? hash(options.model) : null
      }
      publish()
    }
    let ended = false
    try {
      for await (const chunk of next()) {
        if (item && marked && chunk.type === 'text-delta') {
          item.facts.textDeltaCount++
          publish()
        }
        yield chunk // Exact original chunk, including tools-only responses.
      }
      ended = true
    } finally {
      if (item) {
        item.facts.lastStreamMarked = marked && ended
        item.eligible = item.facts.lastStreamMarked && !item.facts.requestAborted && !item.facts.runtimeErrorSeen
        publish()
      }
    }
  })
  ctx.on('tools/result', (exec, result) => {
    // Result ownership is exec.agent, NOT whichever initiator happens to be
    // current during dispatch. Tokens/args/results stay in memory only.
    const item = record(exec.agent)
    if (!item) return
    if (exec.name === 'structured_output') {
      item.facts.structuredResultCount++
      const value = result.value
      const receiptValid =
        result.isError === false &&
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === 1 &&
        value.recorded === true
      if (!receiptValid || !item.eligible) {
        publish()
        return
      }
      if (!exactNonce(exec.arguments)) {
        item.facts.nonceMismatch = true
        publish()
        return
      }
      // Mirror only the transport commit barrier, never stage/capture a value.
      if (exec.parent === undefined) item.facts.authoritativeResultCount++
      else item.pending = exec.parent
    } else if (item.pending !== undefined && exec.token === item.pending) {
      item.pending = undefined
      if (result.isError === false) {
        item.facts.authoritativeResultCount++
        item.facts.parentCommitCount++
      }
    }
    publish()
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const item = record(agent)
    if (!item) return
    const endings = agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
    // Earlier successful turns cannot mask the actual final failed/aborted turn.
    item.facts.completed = endings.at(-1)?.data.reason?.kind === 'completed'
    item.facts.disposed = true
    item.pending = undefined
    publish()
  })
  publish()
  return { snapshot }
}

/** Bound the entire observer phase, including each loopback RPC, to 30s.
 * Injectable clock/pause are for pure deterministic deadline tests, not CLI
 * flags. No provider retry is performed here; only inspectRun is repeated. */
export async function observeStructuredRun(inspect, { now = Date.now, pause = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  const deadline = now() + OBSERVATION_MS
  while (now() < deadline) {
    let timer
    let snapshot
    try {
      snapshot = await Promise.race([
        inspect(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new StructuredLiveError('STRUCTURED_OBSERVATION_TIMEOUT')), Math.max(0, deadline - now()))
        })
      ])
    } finally {
      clearTimeout(timer)
    }
    if (now() >= deadline) fail('STRUCTURED_OBSERVATION_TIMEOUT')
    if (snapshot && isRunObservationComplete(snapshot.state)) return snapshot
    await pause(Math.min(50, Math.max(0, deadline - now())))
  }
  fail('STRUCTURED_OBSERVATION_TIMEOUT')
}

function payload(attempt) {
  try {
    return JSON.parse(attempt.outputJson).outputs.payload
  } catch {
    return undefined
  }
}
function exactNonceObject(value, nonce) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, 'nonce') &&
    value.nonce === nonce
  )
}
export function assertStructuredJourney(snapshot, observed, expected) {
  if (!snapshot || !isRunObservationComplete(snapshot.state)) fail('STRUCTURED_OBSERVATION_TIMEOUT')
  if (snapshot.state !== 'succeeded') fail('STRUCTURED_RUN_NOT_SUCCEEDED')
  if (snapshot.definitionRevision !== expected.semanticRevision) fail('STRUCTURED_SAVED_REVISION_MISMATCH')
  const models = snapshot.attempts?.filter(item => item.nodeId === 'model') ?? []
  const downstreams = snapshot.attempts?.filter(item => item.nodeId === 'downstream') ?? []
  if (models.length !== 1 || downstreams.length !== 1) fail('STRUCTURED_ATTEMPT_MISSING')
  const [model] = models,
    [downstream] = downstreams
  if (model.state !== 'succeeded' || model.resultKind !== 'succeeded') fail('STRUCTURED_ATTEMPT_MISSING')
  const records = observed?.sessions?.filter(item => item.run_sha256 === sha256(snapshot.runId) && item.attempt_sha256 === sha256(model.attemptId)) ?? []
  if (records.length !== 1) fail('STRUCTURED_AGENT_FACTS_MISSING')
  const [facts] = records
  if (![facts.agentCreated, facts.inboxSeen, facts.scopedAgentSeen, facts.requestSeen].every(value => value === true)) fail('STRUCTURED_AGENT_FACTS_MISSING')
  if (facts.markedRequestCount !== 1 || facts.lastStreamMarked !== true) fail('STRUCTURED_MARKER_MISSING')
  if (facts.nonceMismatch) fail('STRUCTURED_NONCE_MISMATCH')
  if (facts.authoritativeResultCount !== 1) fail('STRUCTURED_AUTHORITY_MISSING')
  if (!facts.completed || !facts.disposed || facts.requestAborted || facts.runtimeErrorSeen) fail('STRUCTURED_TERMINAL_INCOMPLETE')
  const diagnostics = model.diagnostics
  if (diagnostics?.status !== 'available') fail('STRUCTURED_DIAGNOSTICS_UNAVAILABLE')
  // Canonical W2 code is 'accepted'; schema-valid is its meaning, not an alias.
  if (diagnostics.acceptance?.code !== 'accepted') fail('STRUCTURED_ACCEPTANCE_MISMATCH')
  const provider = expected.provider === undefined ? 'blueprint-live' : expected.provider
  if (provider !== 'blueprint-live') {
    if (!isBuiltinProvider(provider)) fail('STRUCTURED_MODEL_MISMATCH')
    try {
      builtinModel(provider, expected.model)
    } catch {
      fail('STRUCTURED_MODEL_MISMATCH')
    }
  }
  if (
    facts.request_provider_sha256 !== sha256(provider) ||
    facts.request_model_sha256 !== sha256(expected.model) ||
    diagnostics.modelSelection?.provider !== provider ||
    diagnostics.modelSelection?.model !== expected.model
  )
    fail('STRUCTURED_MODEL_MISMATCH')
  if (diagnostics.resourceDigests?.answerSchema !== expected.schemaSha256) fail('STRUCTURED_SCHEMA_DIGEST_MISMATCH')
  if (diagnostics.resourceDigests?.worker !== expected.agentSha256 || !/^[a-f0-9]{64}$/.test(diagnostics.resourceDigests?.$package ?? ''))
    fail('STRUCTURED_AGENT_DIGEST_MISMATCH')
  if (
    diagnostics.input?.type !== 'object' ||
    diagnostics.input.bytes !== Buffer.byteLength(expected.inputJson) ||
    diagnostics.input.sha256 !== sha256(expected.inputJson)
  )
    fail('STRUCTURED_INPUT_DIGEST_MISMATCH')
  if (!Array.isArray(diagnostics.tools?.effectiveNames) || diagnostics.tools.effectiveNames.length !== 0 || (diagnostics.tools.denials?.length ?? 0) !== 0)
    fail('STRUCTURED_TOOL_POLICY_MISMATCH')
  const output = payload(model)
  if (!exactNonceObject(output, expected.nonce)) fail('STRUCTURED_OUTPUT_MISMATCH')
  if (downstream.state !== 'succeeded' || downstream.resultKind !== 'succeeded' || !exactNonceObject(payload(downstream), expected.nonce))
    fail('STRUCTURED_DOWNSTREAM_MISMATCH')
  return {
    savedDefinitionAdmitted: true,
    scopedAgentSeen: true,
    agentLoopMarked: true,
    authoritativeStructuredResult: true,
    terminalCompleted: true,
    schemaValidAcceptance: true,
    actualModelMatched: true,
    frozenSchemaMatched: true,
    frozenAgentMatched: true,
    dispatchedInputMatched: true,
    effectiveToolPolicyMatched: true,
    exactNonceMatched: true,
    downstreamMatched: true,
    markedRequestCount: facts.markedRequestCount,
    structuredResultCount: facts.structuredResultCount,
    authoritativeResultCount: facts.authoritativeResultCount,
    parentCommitCount: facts.parentCommitCount,
    output_sha256: sha256(JSON.stringify(output)),
    nonce_sha256: sha256(expected.nonce),
    model_sha256: sha256(diagnostics.modelSelection.model),
    schema_sha256: expected.schemaSha256
  }
}

export function createStructuredBlueprint() {
  const schemaBytes = JSON.stringify({ type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false })
  const agentBytes = 'Call structured_output exactly once with the exact nonce from the input JSON. Do not report it as text. Do not add other properties.\n'
  const definition = {
    schemaVersion: 2,
    id: 'live-journey',
    name: 'Runtime contracts structured nonce journey',
    resources: {
      worker: { kind: 'agent', path: 'lib/agents/worker.md' },
      answerSchema: { kind: 'schema', path: 'lib/schema/answer.json' }
    },
    graph: {
      nodes: [
        { id: 'model', kind: 'agentTask', agentRef: 'worker', outputSchemaRef: 'answerSchema', outputs: { payload: 'json' } },
        { id: 'downstream', kind: 'output', inputs: { payload: 'json' }, outputs: { payload: 'json' } }
      ],
      edges: [{ kind: 'data', from: 'model.payload', to: 'downstream.payload' }]
    }
  }
  return { definition, agentBytes, schemaBytes }
}

export function parseCli(argv) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 4 ||
    argv[0] !== '--plan-id' ||
    argv[1] !== PLAN ||
    argv[2] !== '--report-dir' ||
    typeof argv[3] !== 'string' ||
    !isAbsolute(argv[3]) ||
    [...argv[3]].some(char => char.charCodeAt(0) <= 0x1f)
  )
    fail('STRUCTURED_CLI_INVALID')
  return { planId: PLAN, reportDir: argv[3] }
}
export function classifyFailure(error) {
  if (error instanceof VerificationNotRunError && NOT_RUN_CODES.has(error.reasonCode)) {
    return { status: 'not-run', code: error.reasonCode, exit_code: 2 }
  }
  return { status: 'failed', code: CODES.has(error?.code) ? error.code : 'STRUCTURED_LIVE_FAILED', exit_code: 1 }
}
const BOOL_ASSERTIONS = [
  'savedDefinitionAdmitted',
  'scopedAgentSeen',
  'agentLoopMarked',
  'authoritativeStructuredResult',
  'terminalCompleted',
  'schemaValidAcceptance',
  'actualModelMatched',
  'frozenSchemaMatched',
  'frozenAgentMatched',
  'dispatchedInputMatched',
  'effectiveToolPolicyMatched',
  'exactNonceMatched',
  'downstreamMatched',
  'providerAttempted'
]
const COUNT_ASSERTIONS = ['markedRequestCount', 'structuredResultCount', 'authoritativeResultCount', 'parentCommitCount']
const RESULT_CODES = [
  'succeeded',
  'failed',
  'provider-failed',
  'timeout',
  'cancelled',
  'recovery_required',
  'structured-output-missing',
  'output-invalid',
  'schema-valid',
  'accepted',
  'composition-unsupported'
]
const HASH_ASSERTIONS = ['output_sha256', 'nonce_sha256', 'model_sha256', 'schema_sha256']
function projectAssertions(input = {}) {
  const output = {}
  for (const name of BOOL_ASSERTIONS) if (typeof input[name] === 'boolean') output[name] = input[name]
  for (const name of COUNT_ASSERTIONS) if (Number.isSafeInteger(input[name]) && input[name] >= 0) output[name] = input[name]
  for (const name of HASH_ASSERTIONS) if (/^[a-f0-9]{64}$/.test(input[name] ?? '')) output[name] = input[name]
  for (const name of ['producer_result_code', 'acceptance_code']) if (RESULT_CODES.includes(input[name])) output[name] = input[name]
  return output
}
function projectFingerprint(input) {
  const checked = (value, length) => (typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value) ? value : null)
  return { revision: checked(input?.revision, 40), source_sha256: checked(input?.source_sha256, 64), artifact_sha256: checked(input?.artifact_sha256, 64) }
}
const shellQuote = value => (/^[\w/.:=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`)
export function createReceipt(spec) {
  const provider = spec.provider === undefined ? 'blueprint-live' : spec.provider
  if (provider !== 'blueprint-live' && !isBuiltinProvider(provider)) fail('STRUCTURED_MODEL_MISMATCH')
  const before = projectFingerprint(spec.before),
    after = projectFingerprint(spec.after)
  const stable = Object.keys(before).every(key => before[key] !== null && before[key] === after[key])
  let result
  if (spec.result?.status === 'passed' && spec.result.code === 'STRUCTURED_LIVE_VERIFIED') {
    result = stable
      ? { status: 'passed', code: 'STRUCTURED_LIVE_VERIFIED', exit_code: 0 }
      : { status: 'failed', code: 'STRUCTURED_FINGERPRINT_CHANGED', exit_code: 1 }
  } else if (spec.result?.status === 'not-run' && NOT_RUN_CODES.has(spec.result.code)) {
    result = { status: 'not-run', code: spec.result.code, exit_code: 2 }
  } else {
    result = { status: 'failed', code: CODES.has(spec.result?.code) ? spec.result.code : 'STRUCTURED_LIVE_FAILED', exit_code: 1 }
  }
  const version = value => (typeof value === 'string' && /^[v\d][\w.+-]{0,79}$/.test(value) ? value : null)
  return {
    schema_version: 1,
    gate: 'G-RC-LIVE',
    plan_id: PLAN,
    exact_command: `node ${shellQuote(spec.entry ?? 'test/live/runtime-contracts-journey.mjs')} --plan-id ${PLAN} --report-dir ${shellQuote(spec.reportDir)}`,
    cwd: spec.cwd,
    started_at: spec.startedAt,
    finished_at: spec.finishedAt,
    status: result.status,
    reason_code: result.code,
    exit_code: result.exit_code,
    before,
    after,
    fingerprints_stable: stable,
    plan_sha256: /^[a-f0-9]{64}$/.test(spec.planSha256 ?? '') ? spec.planSha256 : null,
    identity: {
      os: ['darwin', 'linux', 'win32'].includes(spec.identity.os) ? spec.identity.os : 'other',
      arch: ['arm64', 'x64', 'ia32', 'arm'].includes(spec.identity.arch) ? spec.identity.arch : 'other',
      osRelease: version(spec.identity.osRelease),
      node: version(spec.identity.node),
      dshVersion: version(spec.identity.dshVersion)
    },
    profile: 'isolated-temporary',
    backend: 'json',
    provider,
    protocol: ['openai-completions', 'openai-responses', 'anthropic-messages'].includes(spec.protocol) ? spec.protocol : 'unavailable',
    budgets_ms: { agent: null, observer: OBSERVATION_MS },
    assertions: projectAssertions(spec.assertions)
  }
}

// Narrow private boot/stop helpers copied in shape, not exported from or added
// to the old journey. Bounded tails never leave memory, even on host failures.
function boot(cli, profile, env, cwd) {
  const child = spawn(cli, ['--profile', profile, '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const ready = new Promise((resolveReady, reject) => {
    let tail = '',
      settled = false
    const timer = setTimeout(() => finish(new StructuredLiveError('STRUCTURED_HOST_BOOT_TIMEOUT')), 30000)
    function finish(error, url) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      tail = ''
      if (error) reject(error)
      else resolveReady(url)
    }
    const take = chunk => {
      if (settled) return
      tail = (tail + chunk.toString()).slice(-8192)
      const match = tail.match(/http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/[^\s]*token=[A-Za-z0-9._-]+/)
      if (match) finish(undefined, match[0])
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.once('error', () => finish(new StructuredLiveError('STRUCTURED_HOST_BOOT_FAILED')))
    child.once('exit', () => finish(new StructuredLiveError('STRUCTURED_HOST_EXITED')))
  })
  return { child, ready }
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise(resolveStop => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveStop()
    })
    child.kill('SIGTERM')
  })
}
function observerSource(publicLlmEntry) {
  return `import { writeFileSync, renameSync } from 'node:fs';\nimport { createHash } from 'node:crypto';\nimport { isAgentLoopRequest } from ${JSON.stringify(publicLlmEntry)};\nexport const inject = ['agents', 'llm'];\nconst createStructuredObserver = ${createStructuredObserver.toString()};\nexport function apply(ctx) {\n  const path = process.env.BP_RUNTIME_LIVE_OBSERVER_FILE;\n  const hash = value => createHash('sha256').update(value).digest('hex');\n  createStructuredObserver(ctx, { nonce: process.env.BP_RUNTIME_LIVE_NONCE, isAgentLoopRequest, hash, flush: facts => { writeFileSync(path + '.next', JSON.stringify(facts), {mode:0o600}); renameSync(path + '.next', path) } });\n}\n`
}
function readObserved(path) {
  if (!existsSync(path)) return { sessions: [] }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    fail('STRUCTURED_OBSERVER_FAILED')
  }
}
export async function runIsolatedStructured(config, progress, { diagnosticBudget } = {}) {
  config = revalidateConfiguration(config)
  const cli = join(REPO_ROOT, 'test/blueprint/node_modules/.bin/dsh')
  if (!existsSync(cli) || !existsSync(join(PACKAGE_ROOT, 'lib/index.js'))) {
    throw new VerificationNotRunError('LIVE_HOST_OR_ARTIFACT_MISSING', 'installed host or Main-built artifact unavailable')
  }
  const temp = mkdtempSync(join(tmpdir(), 'bp-runtime-live-'))
  let child, gateway, runId, observerFile
  try {
    const home = join(temp, 'home'),
      cwd = join(temp, 'cwd'),
      profile = `bp-runtime-live-${randomUUID()}`
    const dir = join(home, 'dsh/profiles', profile),
      workspace = join(temp, 'workspace'),
      bp = join(workspace, '.xuanling', 'workflows', 'live-journey'),
      runtime = join(workspace, '.xuanling')
    for (const path of [
      dir,
      cwd,
      join(home, 'tmp'),
      join(dir, 'node_modules/@xuanling-rs'),
      runtime,
      workspace,
      join(bp, 'lib/agents'),
      join(bp, 'lib/schema')
    ])
      mkdirSync(path, { recursive: true })
    const blueprint = createStructuredBlueprint()
    writeFileSync(join(bp, 'blueprint.json'), JSON.stringify(blueprint.definition), { mode: 0o600 })
    writeFileSync(join(bp, 'lib/agents/worker.md'), blueprint.agentBytes, { mode: 0o600 })
    writeFileSync(join(bp, 'lib/schema/answer.json'), blueprint.schemaBytes, { mode: 0o600 })
    symlinkSync(PACKAGE_ROOT, join(dir, 'node_modules/@xuanling-rs/xuanling-dsh-blueprint'), 'dir')
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: profile,
        private: true,
        type: 'module',
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', PACKAGE] } }
      }),
      { mode: 0o600 }
    )
    const nm = join(REPO_ROOT, 'test/blueprint/node_modules'),
      toolIds = []
    for (const bundle of ['dsh-base', 'dsh-web-app']) {
      const yaml = readFileSync(join(nm, '@deepseek-ai', bundle, 'cordis.patch.yml'), 'utf8')
      for (const match of yaml.matchAll(/id: (tool-[\w-]+)/g)) toolIds.push(match[1])
    }
    symlinkSync(nm, join(temp, 'node_modules'), 'dir')
    const require = createRequire(join(REPO_ROOT, 'test/blueprint/package.json'))
    const observer = join(temp, 'observer.mjs')
    writeFileSync(observer, observerSource(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href), { mode: 0o600 })
    observerFile = join(temp, 'observer-facts.json')
    writeFileSync(
      join(dir, 'cordis.patch.yml'),
      profilePatch({ workspaceRoot: workspace, runtimeRoot: runtime, observerModule: observer, toolIds, liveConfig: config }),
      { mode: 0o600 }
    )
    const nonce = `bp-runtime-live-${randomUUID()}`,
      inputJson = JSON.stringify({ nonce })
    const env = isolatedJourneyEnvironment(home, config, diagnosticBudget)
    env.BP_RUNTIME_LIVE_OBSERVER_FILE = observerFile
    env.BP_RUNTIME_LIVE_NONCE = nonce
    const host = boot(cli, profile, env, cwd)
    child = host.child
    gateway = makeGateway(await host.ready)
    await gateway.authenticate()
    const ping = await gateway.call('blueprint/ping', {})
    if (ping?.status !== 'ok' || ping.service !== PACKAGE) fail('STRUCTURED_PLUGIN_NOT_MOUNTED')
    const definition = await gateway.call('blueprint/loadDefinition', { args: { blueprintId: 'live-journey' } })
    // Public saved-document admission, not the internal definitionJson bypass.
    const started = await gateway.call('blueprint/startRun', {
      args: { blueprintId: 'live-journey', expectedRevision: definition.documentRevision, inputJson, requestId: randomUUID() }
    })
    runId = started.runId
    if (typeof runId !== 'string' || started.replayed !== false || started.semanticRevision !== definition.semanticRevision)
      fail('STRUCTURED_RUN_ADMISSION_INVALID')
    progress.savedDefinitionAdmitted = true
    const snapshot = await observeStructuredRun(() => gateway.call('blueprint/inspectRun', { args: { runId } }))
    const producer = snapshot.attempts?.find(item => item.nodeId === 'model')
    progress.producer_result_code = producer?.resultKind
    progress.acceptance_code = producer?.diagnostics?.acceptance?.code
    const observed = readObserved(observerFile)
    for (const item of observed.sessions ?? []) {
      progress.providerAttempted ||= item.markedRequestCount > 0
      for (const key of COUNT_ASSERTIONS) progress[key] = (progress[key] ?? 0) + (item[key] ?? 0)
    }
    const facts = assertStructuredJourney(snapshot, observed, {
      nonce,
      inputJson,
      schemaSha256: sha256(blueprint.schemaBytes),
      agentSha256: sha256(blueprint.agentBytes),
      model: config.model,
      provider: config.provider,
      semanticRevision: definition.semanticRevision
    })
    Object.assign(progress, facts)
    return facts
  } finally {
    if (observerFile) {
      // Never archive the local observer file; retain only its whitelisted
      // counters on a failing/timeout Run as well as on success.
      try {
        const observed = readObserved(observerFile)
        for (const key of COUNT_ASSERTIONS) progress[key] = (observed.sessions ?? []).reduce((n, item) => n + (item[key] ?? 0), 0)
        progress.providerAttempted = (observed.sessions ?? []).some(item => item.markedRequestCount > 0)
      } catch {
        /* no raw local read error */
      }
    }
    // One Run only. No provider retry/replay/restart can rescue a failed oracle.
    if (gateway && runId) {
      try {
        await gateway.call('blueprint/cancelRun', { args: { runId } })
      } catch {
        /* static failure only */
      }
    }
    await stop(child)
    rmSync(temp, { recursive: true, force: true })
  }
}
function installedIdentity() {
  let dshVersion = null
  try {
    dshVersion = JSON.parse(readFileSync(join(REPO_ROOT, 'test/blueprint/node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version
  } catch {
    /* do not archive dependency errors */
  }
  return { os: platform(), arch: arch(), osRelease: release(), node: process.version, dshVersion }
}
export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseCli(argv)
  const startedAt = new Date().toISOString(),
    identity = installedIdentity()
  const before = captureEvidenceFingerprint({ packageRoot: PACKAGE_ROOT, repoRoot: REPO_ROOT })
  const planSha256 = sha256(readFileSync(join(REPO_ROOT, 'docs/plans/dsh-blueprint-runtime-contracts-development-plan.md')))
  const assertions = { providerAttempted: false }
  let protocol, provider, result
  try {
    const config = configuration(env)
    protocol = config.protocol
    provider = config.provider
    if (!identity.dshVersion) throw new VerificationNotRunError('STRUCTURED_DSH_UNAVAILABLE', 'installed DSH identity unavailable')
    await runIsolatedStructured(config, assertions)
    result = { status: 'passed', code: 'STRUCTURED_LIVE_VERIFIED', exit_code: 0 }
  } catch (error) {
    result = classifyFailure(error)
  }
  const after = captureEvidenceFingerprint({ packageRoot: PACKAGE_ROOT, repoRoot: REPO_ROOT })
  const receipt = createReceipt({
    ...options,
    cwd: process.cwd(),
    startedAt,
    finishedAt: new Date().toISOString(),
    before,
    after,
    planSha256,
    identity,
    protocol,
    provider,
    assertions,
    result,
    entry: relative(process.cwd(), fileURLToPath(import.meta.url))
  })
  mkdirSync(options.reportDir, { recursive: true })
  writeFileSync(join(options.reportDir, 'runtime-live-gate.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  return receipt
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const receipt = await main()
    process.stdout.write(JSON.stringify({ gate: receipt.gate, status: receipt.status, reason_code: receipt.reason_code, exit_code: receipt.exit_code }) + '\n')
    process.exitCode = receipt.exit_code
  } catch (error) {
    const result = classifyFailure(error)
    process.stdout.write(JSON.stringify({ gate: 'G-RC-LIVE', status: result.status, reason_code: result.code, exit_code: result.exit_code }) + '\n')
    process.exitCode = result.exit_code
  }
}
