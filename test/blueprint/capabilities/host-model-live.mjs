/** Explicitly authorized selected-provider acceptance in an owned, disposable
 * profile. No factory, stream, model response or acceptance facts are mocked. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import yaml from 'js-yaml'
import { prepareProfile, bootHost, stopHost } from './conversation-runtime.mjs'

const HELP = 'node test/blueprint/capabilities/host-model-live.mjs --authorized-web-profile <absolute profile> --report-dir <fresh absolute directory>\nnode --experimental-transform-types test/blueprint/capabilities/host-model-live.mjs --self-test\nRuns exactly one explicit selected-model AgentTask and one default-fallback AgentTask in an ephemeral profile. Copies only the selected provider and its credential. Reports nonce, public Agent/LLM route and frozen Host composition checks; never writes provider bodies or credentials. No automatic redispatch. Self-test only uses production projection with in-memory fixtures.'
if (process.argv.includes('--help')) { console.log(HELP); process.exit(0) }
const hash = value => createHash('sha256').update(value).digest('hex')
const fail = code => { throw Object.assign(new Error(code), { collectorCode: code }) }
const requireFact = (value, code) => { if (!value) fail(code) }
const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n]/.test(value)
function outputHasExactNonce(outputJson, nonce) {
  try { return JSON.parse(outputJson)?.outputs?.text === nonce }
  catch { return false }
}
const INPUT_PROTOCOL = 'token-last-line-v1'
function validationPrompt(nonce) {
  return 'Return only the token on the next line, unchanged. Do not add quotes, punctuation, whitespace, or explanations. Do not use tools.\n' + nonce
}
function projectSafeOutput(outputJson, nonce) {
  if (typeof outputJson !== 'string') return { status: 'unavailable' }
  const facts = { bytes: Buffer.byteLength(outputJson), sha256: hash(outputJson), status: 'invalid-json' }
  try {
    const output = JSON.parse(outputJson), text = output?.outputs?.text
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    // Unknown output keys are generated content too. Preserve their identity
    // as hashes rather than allowing raw model text into a structure receipt.
    const keys = (value, allowed) => object(value) ? Object.keys(value).map(key => allowed.includes(key) ? key : `unknown:${hash(key)}`) : []
    facts.status = 'parsed'
    facts.topLevelKeys = keys(output, ['outputs', 'value'])
    facts.outputsKeys = keys(output?.outputs, ['text'])
    facts.textType = text === null ? 'null' : Array.isArray(text) ? 'array' : typeof text
    facts.exactNonce = text === nonce
    if (typeof text === 'string') {
      facts.textLength = text.length; facts.textBytes = Buffer.byteLength(text); facts.textSha256 = hash(text)
      facts.noncePresent = text.includes(nonce) // Diagnostic only; never an acceptance gate.
    }
  } catch { /* The original bytes are represented only by length and digest. */ }
  return facts
}
if (process.argv.includes('--self-test')) {
  const { projectRunSnapshot } = await import('../../../integrations/deepseek-harness/xuanling-blueprint/src/conversation/run-projection.ts')
  const nonce = 'BP_MODEL_SELF_TEST_EXACT'
  const prompt = validationPrompt(nonce)
  assert.equal(prompt.split('\n').at(-1), nonce)
  assert.equal(prompt.endsWith(`\n${nonce}`), true)
  assert.equal(JSON.parse(JSON.stringify(prompt)), prompt)
  assert.equal(prompt.startsWith('"'), false)
  const project = text => projectRunSnapshot({ runId: 'self-test-run', state: 'succeeded', definitionRevision: 'self-test-revision', seq: 1, log: [],
    attempts: [{ nodeId: 'task', state: 'succeeded', attempt: 1, attemptId: 'self-test-attempt', sessionId: 'bp-self-test-session',
      result: { ok: true, outcome: { outputs: { text }, value: text } } }] }).attempts[0]
  const attempt = project(nonce)
  assert.equal(outputHasExactNonce(attempt.outputJson, nonce), true)
  assert.equal(attempt.sessionId, 'bp-self-test-session')
  for (const value of [` ${nonce}`, `${nonce}\n`, `${nonce}-extra`, 'other']) assert.equal(outputHasExactNonce(project(value).outputJson, nonce), false)
  for (const value of [JSON.stringify(nonce), JSON.stringify({ text: nonce }), JSON.stringify({ value: nonce }), 'invalid-json']) assert.equal(outputHasExactNonce(value, nonce), false)
  const raw = 'RAW_PROVIDER_OUTPUT_MUST_NOT_ENTER_RECEIPT', projected = projectSafeOutput(JSON.stringify({ outputs: { text: `${raw}:${nonce}`, [raw]: raw }, value: raw, [raw]: raw }), nonce)
  assert.equal(JSON.stringify(projected).includes(raw), false)
  assert.equal(JSON.stringify(projected).includes(nonce), false)
  assert.equal(projected.exactNonce, false); assert.equal(projected.noncePresent, true)
  assert.equal(projectSafeOutput(attempt.outputJson, nonce).exactNonce, true)
  assert.deepEqual(projected.topLevelKeys.slice(0, 2), ['outputs', 'value'])
  assert.equal(projected.textType, 'string'); assert.equal(projected.textLength, raw.length + 1 + nonce.length)
  assert.equal(projectSafeOutput('invalid-json', nonce).status, 'invalid-json')
  console.log(JSON.stringify({ ok: true, provenance: 'production projectRunSnapshot + in-memory fixtures', inputProtocol: INPUT_PROTOCOL, checks: ['token is last standalone input line', 'input JSON roundtrip preserves original string bytes', 'exact wrapped outputs.text', 'public attempt sessionId', 'no trim/contains/top-level fallback', 'safe structure contains no raw output or nonce', 'nonce presence is diagnostic only'] }))
  process.exit(0)
}
const codes = new Set(['ARGUMENT_INVALID', 'REPORT_NOT_FRESH', 'SELECTED_PROFILE_INVALID', 'SELECTED_PROVIDER_UNAVAILABLE', 'SELECTED_CREDENTIAL_UNAVAILABLE', 'HOST_AUTH_FAILED', 'RPC_FAILED', 'MINIMAL_PRESET_UNAVAILABLE', 'PREFLIGHT_BLOCKED', 'RUN_TIMEOUT', 'RUN_FAILED', 'OUTPUT_NONCE_MISMATCH', 'DIAGNOSTICS_UNAVAILABLE', 'DURABLE_MODEL_MISMATCH', 'FACTORY_MODEL_UNKNOWN', 'FACTORY_MODEL_MISMATCH', 'PROVIDER_REQUEST_UNKNOWN', 'PROVIDER_MODEL_MISMATCH', 'PROVIDER_REQUEST_FAILED', 'HOST_COMPOSITION_UNKNOWN', 'HOST_COMPOSITION_MISMATCH', 'HOST_SNAPSHOT_MISSING', 'HOST_SNAPSHOT_INVALID', 'CLEANUP_FAILED'])
const category = error => {
  if (codes.has(error?.collectorCode)) return error.collectorCode
  if (['HOST_BOOT_TIMEOUT', 'HOST_STOP_TIMEOUT', 'HOST_EXITED', 'HOST_BOOT_FAILED', 'HOST_CLI_FAILED', 'HOST_PNPM_UNAVAILABLE', 'HOST_VERSION_MISMATCH', 'HOST_OR_ARTIFACT_MISSING'].includes(error?.code ?? error?.message)) return error.code ?? error.message
  return ['TimeoutError', 'AbortError'].includes(error?.name) ? 'TRANSPORT_TIMEOUT' : 'UNCLASSIFIED_FAILURE'
}

/** Executed in the isolated Host. Public observation only; no interception of
 * factory arguments and no response substitution. Raw errors stay in memory. */
function attachObserver(ctx, { flush, digest, loadComposition }) {
  const facts = { provenance: 'public agent/created + llm/stream + agentPresets.readDocument', agents: [], composition: { status: 'UNKNOWN' } }
  const byAgent = new WeakMap()
  const route = value => value && typeof value.provider === 'string' && typeof value.model === 'string'
    ? { provider: value.provider, model: value.model, ...(typeof value.reasoningEffort === 'string' ? { reasoningEffort: value.reasoningEffort } : {}) } : null
  const publish = () => flush(facts)
  ctx.on('agent/created', async ({ agent }) => {
    const item = { sessionId: agent.id, factorySelection: route(agent.options), requests: [], errors: [], disposed: false }
    byAgent.set(agent, item); facts.agents.push(item)
    try {
      const document = await ctx.get('agentPresets').readDocument('minimal')
      const plugins = loadComposition(document.content)
      if (Array.isArray(plugins)) facts.composition = { status: 'available', sha256: digest(JSON.stringify({ plugins })) }
    } catch { facts.composition = { status: 'UNKNOWN' } }
    publish()
  })
  ctx.on('llm/stream', async function* (options, next) {
    const agent = ctx.get('agents')?.currentInitiator(), item = agent && byAgent.get(agent)
    const request = item && options.sessionId === agent.id ? { selection: route(options), finished: false, failed: false, textDeltas: 0 } : undefined
    if (request) { item.requests.push(request); publish() }
    try {
      for await (const chunk of next()) {
        if (request && chunk.type === 'text-delta' && chunk.text?.length) request.textDeltas++
        yield chunk
      }
    } catch (error) { if (request) request.failed = true; throw error }
    finally { if (request) { request.finished = true; publish() } }
  }, { prepend: true })
  ctx.on('agent/error', ({ agent, error }) => {
    const item = byAgent.get(agent)
    if (!item) return
    const message = String(error?.message ?? '').toLowerCase()
    item.errors.push({ type: ['Error', 'TypeError', 'HarnessError', 'AbortError', 'LlmError'].includes(error?.name) ? error.name : 'other',
      categories: ['timeout', 'rate limit', 'abort', 'network', 'fetch', 'schema'].filter(word => message.includes(word)) })
    publish()
  })
  ctx.on('agent/disposed', ({ agent }) => { const item = byAgent.get(agent); if (item) { item.disposed = true; publish() } })
  publish()
}

requireFact(process.argv.length === 6 && process.argv[2] === '--authorized-web-profile' && process.argv[4] === '--report-dir'
  && isAbsolute(process.argv[3]) && isAbsolute(process.argv[5]), 'ARGUMENT_INVALID')
const authorizedProfile = resolve(process.argv[3]), reportDir = resolve(process.argv[5])
requireFact(!existsSync(reportDir), 'REPORT_NOT_FRESH')
mkdirSync(reportDir, { recursive: true, mode: 0o700 })
const root = mkdtempSync(join(realpathSync(tmpdir()), 'bp-host-model-live-'))
const receipt = { planId: 'dsh-blueprint-host-resources-model-v1', startedAt: new Date().toISOString(), steps: [], rpc: [], runs: [], providerEvidence: false, credentialsRecorded: false, redispatchCount: 0 }
let host, profile, rpc, activeRun
const observerFile = join(root, 'model-observer.json')
const readObserver = () => existsSync(observerFile) ? JSON.parse(readFileSync(observerFile, 'utf8')) : { agents: [], composition: { status: 'UNKNOWN' } }
try {
  const patch = yaml.load(readFileSync(join(authorizedProfile, 'cordis.patch.yml'), 'utf8'))
  requireFact(Array.isArray(patch), 'SELECTED_PROFILE_INVALID')
  const selected = patch.find(entry => entry.id === 'agent-default-model')?.config
  requireFact(selected && safeId(selected.provider) && safeId(selected.model) && (selected.reasoningEffort === undefined || safeId(selected.reasoningEffort)), 'SELECTED_PROFILE_INVALID')
  const selection = { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) }
  const provider = patch.find(entry => entry.id === 'llm-pi-ai')?.config?.providers?.[selection.provider]
  requireFact(provider && typeof provider.apiKeyEnv === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.apiKeyEnv), 'SELECTED_PROVIDER_UNAVAILABLE')
  const credentialsFile = resolve(authorizedProfile, '../../.credentials.yaml')
  const credentials = existsSync(credentialsFile) ? yaml.load(readFileSync(credentialsFile, 'utf8')) : { version: 1, refs: {} }
  const key = process.env[provider.apiKeyEnv] ?? credentials.refs?.[provider.apiKeyEnv]
  requireFact(typeof key === 'string' && key.length > 0, 'SELECTED_CREDENTIAL_UNAVAILABLE')
  receipt.selection = selection
  const fixture = { prepare: async () => {
    const blueprints = {}
    for (const mode of ['explicit', 'default']) {
      const id = `host-model-${mode}`, packageRoot = join(root, id)
      mkdirSync(packageRoot, { mode: 0o700 })
      const definition = { schemaVersion: 1, id, name: `Host model ${mode}`, resources: { agent: { kind: 'agent', source: { kind: 'host', id: 'minimal' } } },
        graph: { nodes: [{ id: 'task', kind: 'agentTask', agentRef: 'agent', outputs: { text: 'string' }, ...(mode === 'explicit' ? { modelSelection: selection } : {}) }], edges: [] } }
      writeFileSync(join(packageRoot, 'blueprint.json'), JSON.stringify(definition), { mode: 0o600 })
      blueprints[id] = packageRoot
    }
    const observer = join(root, 'host-model-observer.mjs')
    const source = `import {writeFileSync,renameSync} from 'node:fs';\nimport {createHash} from 'node:crypto';\nimport yaml from 'js-yaml';\nimport {entryListSchema} from '@deepseek-ai/cordis-plugin-include';\nexport const inject=['agents','llm','agentPresets'];\nconst attachObserver=${attachObserver.toString()};\nexport function apply(ctx){attachObserver(ctx,{digest:value=>createHash('sha256').update(value).digest('hex'),loadComposition:content=>yaml.load(content,{schema:entryListSchema}),flush:facts=>{const file=${JSON.stringify(observerFile)};writeFileSync(file+'.next',JSON.stringify(facts),{mode:0o600});renameSync(file+'.next',file)}})}\n`
    writeFileSync(observer, source, { mode: 0o600 })
    return { blueprints, operatorModules: [observer] }
  } }
  profile = await prepareProfile({ mode: 'keyless', installMode: 'cli', pnpmExecutable: process.env.BP_AUTHORING_PNPM }, fixture, root, receipt.steps)
  receipt.artifacts = Object.fromEntries(['index.js', 'client.js'].map(name => [name, hash(readFileSync(join(profile.installedPackage, 'lib', name)))]))
  const overlay = join(profile.profileDir, 'cordis.patch.yml'), entries = yaml.load(readFileSync(overlay, 'utf8'))
  // Resolve observer imports from the actual isolated profile, exactly as the
  // shared public conversation observer does. Link facts by the canonical
  // Attempt sessionId after inspection, without guessing Agent name prefixes.
  const ownedObserver = join(profile.profileDir, 'host-model-observer.mjs')
  const observerSource = readFileSync(join(root, 'host-model-observer.mjs'), 'utf8')
  writeFileSync(ownedObserver, observerSource, { mode: 0o600 })
  const operatorEntry = entries.flatMap(entry => entry.insert ?? []).find(entry => entry.id === 'conversation-operator-0')
  requireFact(operatorEntry, 'SELECTED_PROFILE_INVALID'); operatorEntry.name = ownedObserver
  receipt.observerModuleSha256 = hash(observerSource)
  const pi = entries.find(entry => entry.id === 'llm-pi-ai')
  requireFact(pi, 'SELECTED_PROVIDER_UNAVAILABLE'); delete pi.disabled; pi.config = { providers: { [selection.provider]: provider } }
  entries.push({ id: 'agent-default-model', config: selection })
  writeFileSync(overlay, yaml.dump(entries), { mode: 0o600 })
  writeFileSync(join(profile.home, 'dsh/.credentials.yaml'), yaml.dump({ version: credentials.version ?? 1, refs: { [provider.apiKeyEnv]: key }, records: {} }), { mode: 0o600 })
  host = bootHost(profile, receipt.steps)
  const authUrl = new URL(await host.ready), origin = authUrl.origin
  const auth = await fetch(authUrl, { redirect: 'manual', signal: AbortSignal.timeout(15000) })
  const cookie = (auth.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).join('; ')
  requireFact(cookie && [302, 303].includes(auth.status), 'HOST_AUTH_FAILED')
  rpc = async (method, args) => {
    requireFact(['listResources', 'loadDefinition', 'preflightRun', 'startRun', 'inspectRun', 'cancelRun'].includes(method), 'ARGUMENT_INVALID')
    const rpcId = randomUUID(), response = await fetch(`${origin}/api/blueprint/${method}`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ type: 'client-request', rpcId, method: `blueprint/${method}`, payload: { args: args === undefined ? {} : { args } } }),
    })
    const body = await response.json(), ok = response.status === 200 && body?.type === 'server-response' && body.rpcId === rpcId && body.result?.ok === true
    receipt.rpc.push({ method, at: new Date().toISOString(), status: response.status, ok })
    requireFact(ok, 'RPC_FAILED'); return body.result.value
  }
  const catalog = await rpc('listResources')
  requireFact(catalog.resources.some(row => row.kind === 'agent' && row.id === 'minimal' && row.provenance === 'builtin' && row.availability === 'available'), 'MINIMAL_PRESET_UNAVAILABLE')
  for (const mode of ['explicit', 'default']) {
    const nonce = `BP_MODEL_${mode.toUpperCase()}_${randomUUID().replaceAll('-', '')}`
    const fact = { mode, nonce, status: 'started', providerFacts: 'UNKNOWN', checks: {} }; receipt.runs.push(fact)
    const document = await rpc('loadDefinition', { blueprintId: `host-model-${mode}` })
    const prompt = validationPrompt(nonce), inputJson = JSON.stringify(prompt)
    fact.input = { protocol: INPUT_PROTOCOL, sha256: hash(prompt), bytes: Buffer.byteLength(prompt) }
    const args = { blueprintId: document.blueprintId, expectedRevision: document.documentRevision, inputJson }
    const preflight = await rpc('preflightRun', args)
    fact.preflight = { canStart: preflight.canStart, checks: preflight.checks.map(({ code, status }) => ({ code, status })) }
    requireFact(preflight.canStart, 'PREFLIGHT_BLOCKED')
    const admitted = await rpc('startRun', { ...args, requestId: randomUUID() })
    activeRun = admitted.runId; fact.runId = activeRun
    let snapshot, terminal = false
    const deadline = Date.now() + 180000
    for (let count = 0; count < 180 && Date.now() < deadline; count++) {
      snapshot = await rpc('inspectRun', { runId: activeRun })
      if (['succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_required'].includes(snapshot.state)) { terminal = true; break }
      await new Promise(done => setTimeout(done, 1000))
    }
    fact.state = snapshot?.state ?? 'UNKNOWN'
    fact.attempts = snapshot?.attempts.map(a => ({ nodeId: a.nodeId, state: a.state, resultKind: a.resultKind })) ?? []
    const attempt = snapshot?.attempts.find(a => a.nodeId === 'task'), diagnostics = attempt?.diagnostics
    const observed = readObserver(), agent = observed.agents.find(item => item.sessionId === attempt?.sessionId)
    fact.diagnostics = diagnostics?.status === 'available'
      ? { modelSelection: diagnostics.modelSelection, resourceDigests: diagnostics.resourceDigests } : { status: 'UNKNOWN' }
    fact.observation = agent ?? { status: 'UNKNOWN' }
    fact.publicComposition = observed.composition
    fact.output = projectSafeOutput(attempt?.outputJson, nonce)
    fact.checks.outputNonce = outputHasExactNonce(attempt?.outputJson, nonce)
    fact.checks.durableSelection = diagnostics?.status === 'available' && JSON.stringify(diagnostics.modelSelection) === JSON.stringify(selection)
    fact.checks.factorySelection = Boolean(agent?.factorySelection && JSON.stringify(agent.factorySelection) === JSON.stringify(selection))
    fact.checks.providerSelection = Boolean(agent?.requests.length && agent.requests.every(request => request.selection?.provider === selection.provider && request.selection?.model === selection.model))
    fact.checks.providerCompleted = Boolean(agent?.requests.length && agent.requests.every(request => request.finished && !request.failed) && agent.requests.some(request => request.textDeltas > 0))
    const resourceDigest = diagnostics?.status === 'available' ? diagnostics.resourceDigests.agent : undefined
    fact.checks.publicComposition = observed.composition.status === 'available' && observed.composition.sha256 === resourceDigest
    fact.checks.frozenComposition = false
    fact.frozenSnapshot = { status: 'UNKNOWN' }
    if (typeof resourceDigest === 'string' && /^[0-9a-f]{64}$/.test(resourceDigest)) {
      const frozen = join(root, 'runtime/snapshots/host-agents', `${resourceDigest}.json`)
      fact.frozenSnapshot = { status: 'missing' }
      if (existsSync(frozen)) {
        try {
          const bundle = JSON.parse(readFileSync(frozen, 'utf8')), file = bundle.files?.find(row => row.path === 'preset.json')
          fact.checks.frozenComposition = Boolean(file && hash(Buffer.from(file.base64, 'base64')) === resourceDigest && file.digest === resourceDigest)
          fact.frozenSnapshot = { status: fact.checks.frozenComposition ? 'verified' : 'invalid', sha256: resourceDigest }
        } catch { fact.frozenSnapshot = { status: 'invalid' } }
      }
    }
    fact.routeFacts = fact.checks.durableSelection && fact.checks.factorySelection && fact.checks.providerSelection && fact.checks.providerCompleted ? 'CONFIRMED' : 'UNKNOWN'
    requireFact(terminal, 'RUN_TIMEOUT'); activeRun = undefined
    requireFact(snapshot.state === 'succeeded', 'RUN_FAILED')
    requireFact(fact.checks.outputNonce, 'OUTPUT_NONCE_MISMATCH')
    requireFact(diagnostics?.status === 'available', 'DIAGNOSTICS_UNAVAILABLE')
    requireFact(fact.checks.durableSelection, 'DURABLE_MODEL_MISMATCH')
    requireFact(agent?.factorySelection, 'FACTORY_MODEL_UNKNOWN')
    requireFact(fact.checks.factorySelection, 'FACTORY_MODEL_MISMATCH')
    requireFact(agent.requests.length > 0, 'PROVIDER_REQUEST_UNKNOWN')
    requireFact(fact.checks.providerSelection, 'PROVIDER_MODEL_MISMATCH')
    requireFact(fact.checks.providerCompleted, 'PROVIDER_REQUEST_FAILED')
    requireFact(observed.composition.status === 'available', 'HOST_COMPOSITION_UNKNOWN')
    requireFact(fact.checks.publicComposition, 'HOST_COMPOSITION_MISMATCH')
    requireFact(fact.frozenSnapshot.status !== 'missing', 'HOST_SNAPSHOT_MISSING')
    requireFact(fact.checks.frozenComposition, 'HOST_SNAPSHOT_INVALID')
    fact.providerFacts = 'CONFIRMED'; fact.status = 'passed'
  }
  receipt.providerEvidence = true; receipt.ok = true
} catch (error) {
  receipt.ok = false; receipt.failure = category(error)
  if (receipt.runs.at(-1)?.status === 'started') receipt.runs.at(-1).status = 'failed'
} finally {
  // Retain typed/public facts even when a terminal or transport gate failed.
  // The observer has already projected out prompt, response and raw error data.
  try { receipt.observer = readObserver() } catch { receipt.observer = { status: 'UNKNOWN' } }
  if (activeRun && rpc) {
    try { await rpc('cancelRun', { runId: activeRun }); receipt.cancellationRequested = true }
    catch { receipt.cancellationRequested = false }
  }
  let stopped = false
  try { await stopHost(host?.child); stopped = true }
  catch (error) { receipt.cleanupFailure = category(error); receipt.ok = false }
  try { rmSync(root, { recursive: true, force: true }); receipt.profileRemoved = true }
  catch { receipt.cleanupFailure = 'CLEANUP_FAILED'; receipt.ok = false; receipt.profileRemoved = false }
  receipt.hostStopped = stopped; receipt.finishedAt = new Date().toISOString()
  writeFileSync(join(reportDir, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 })
}
console.log(JSON.stringify({ ok: receipt.ok === true, failure: receipt.failure, providerEvidence: receipt.providerEvidence, runs: receipt.runs.map(({ mode, status, state }) => ({ mode, status, state })), hostStopped: receipt.hostStopped, profileRemoved: receipt.profileRemoved }))
process.exitCode = receipt.ok ? 0 : 1
