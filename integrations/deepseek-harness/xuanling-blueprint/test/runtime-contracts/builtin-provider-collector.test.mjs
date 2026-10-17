// Supplemental keyless collector tests; synthetic facts NEVER prove live success.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { configuration, revalidateConfiguration, isolatedEnvironment, isolatedJourneyEnvironment, profilePatch, runIsolatedJourney } from '../live/journey.mjs'
import { assertStructuredJourney, sha256, createReceipt, classifyFailure, runIsolatedStructured } from '../live/runtime-contracts-journey.mjs'
import { getBuiltinModels } from '../../../../../test/blueprint/node_modules/@earendil-works/pi-ai/dist/providers/all.js'
import { builtinModel } from '../live/builtin-provider-configuration.mjs'
const KEY = 'controlled-opaque-builtin-sentinel'
function fixture(provider = 'deepseek', model = 'deepseek-flash') {
  const nonce = 'controlled-builtin-nonce',
    inputJson = JSON.stringify({ nonce })
  const expected = { provider, model, nonce, inputJson, semanticRevision: 'saved-revision', schemaSha256: sha256('schema'), agentSha256: sha256('agent') }
  const snapshot = {
    runId: 'run-builtin',
    state: 'succeeded',
    definitionRevision: expected.semanticRevision,
    attempts: [
      {
        nodeId: 'model',
        attemptId: 'att-builtin',
        state: 'succeeded',
        resultKind: 'succeeded',
        outputJson: JSON.stringify({ outputs: { payload: { nonce } } }),
        diagnostics: {
          status: 'available',
          acceptance: { code: 'accepted' },
          modelSelection: { provider, model },
          input: { type: 'object', bytes: Buffer.byteLength(inputJson), sha256: sha256(inputJson) },
          resourceDigests: { answerSchema: expected.schemaSha256, worker: expected.agentSha256, $package: sha256('package') },
          tools: { effectiveNames: [], denials: [] }
        }
      },
      { nodeId: 'downstream', state: 'succeeded', resultKind: 'succeeded', outputJson: JSON.stringify({ outputs: { payload: { nonce } } }) }
    ]
  }
  const observed = {
    sessions: [
      {
        run_sha256: sha256(snapshot.runId),
        attempt_sha256: sha256('att-builtin'),
        agentCreated: true,
        inboxSeen: true,
        scopedAgentSeen: true,
        requestSeen: true,
        markedRequestCount: 1,
        lastStreamMarked: true,
        nonceMismatch: false,
        authoritativeResultCount: 1,
        completed: true,
        disposed: true,
        requestAborted: false,
        runtimeErrorSeen: false,
        request_provider_sha256: sha256(provider),
        request_model_sha256: sha256(model),
        structuredResultCount: 1,
        parentCommitCount: 0
      }
    ]
  }
  return { snapshot, observed, expected }
}
test('R-C01 legal explicit builtin configuration is accepted without a custom endpoint', () => {
  const config = configuration({ BP_LIVE_BUILTIN_PROVIDER: 'deepseek', BP_LIVE_PROVIDER_KEY: KEY, BP_LIVE_PROVIDER_MODEL: 'deepseek-flash' })
  assert.equal(config.provider, 'deepseek')
  assert.equal(config.model, 'deepseek-flash')
})
test('R-C02 exact builtin observer and durable identity are accepted without renaming facts', () => {
  const f = fixture()
  assert.equal(assertStructuredJourney(f.snapshot, f.observed, f.expected).actualModelMatched, true)
})
const routes = [
  ['deepseek', 'deepseek-flash', 'https://api.deepseek.com'],
  ['zai-coding-cn', 'glm-5.3-flash', 'https://open.bigmodel.cn/api/coding/paas/v4']
]
const selectedEnv = (provider, model) => ({ BP_LIVE_BUILTIN_PROVIDER: provider, BP_LIVE_PROVIDER_KEY: KEY, BP_LIVE_PROVIDER_MODEL: model })
const selectedConfig = (provider = routes[0][0], model = routes[0][1]) => configuration(selectedEnv(provider, model))
const patchArgs = { blueprintRoot: '/isolated/bp', runtimeRoot: '/isolated/runtime', observerModule: '/isolated/observer.mjs', toolIds: ['tool-bash'] }
const rejects = (fn, code) => assert.throws(fn, error => error.code === code && !error.message.includes(KEY))
for (const [provider, model, baseUrl] of routes) {
  test(`R-C01 ${provider}: installed catalog metadata, exact identity and profile inheritance`, () => {
    const catalog = getBuiltinModels(provider).find(item => item.id === model)
    assert.equal(catalog.provider, provider)
    assert.equal(catalog.api, 'openai-completions')
    assert.equal(catalog.baseUrl, baseUrl)
    assert.equal(builtinModel(provider, model), catalog)
    const config = selectedConfig(provider, model)
    assert.deepEqual(config, { key: KEY, baseUrl: catalog.baseUrl, model: catalog.id, protocol: catalog.api, provider })
    assert.deepEqual(revalidateConfiguration(config), config)
    const env = isolatedEnvironment('/isolated', config, {
      PATH: '/bin',
      BP_LIVE_PROVIDER_BASE_URL: 'override',
      BP_LIVE_PROVIDER_PROTOCOL: 'override',
      BP_LIVE_BUILTIN_PROVIDER: 'override'
    })
    assert.equal(env.BP_LIVE_BUILTIN_PROVIDER, provider)
    assert.equal(env.BP_LIVE_PROVIDER_MODEL, model)
    assert.equal(env.BP_LIVE_PROVIDER_BASE_URL, undefined)
    assert.equal(env.BP_LIVE_PROVIDER_PROTOCOL, undefined)
    assert.deepEqual(configuration(env), config)
    const patch = profilePatch({ ...patchArgs, liveConfig: config })
    const stanza = patch.split('- id: llm-pi-ai\n')[1].split('- id: agent-default-model\n')[0]
    assert.equal(stanza, `  config:\n    providers:\n      ${provider}:\n        apiKeyEnv: BP_LIVE_PROVIDER_KEY\n`)
    assert.match(patch, new RegExp(`provider: ${provider}\\n    model: !!js process.env.BP_LIVE_PROVIDER_MODEL`))
    for (const forbidden of [KEY, baseUrl, 'baseURL:', 'api:', 'models:', 'streamIdleTimeoutMs:', 'blueprint-live:'])
      assert.equal(patch.includes(forbidden), false)
    assert.match(patch, /id: tool-bash\n  disabled: true/)
    const f = fixture(provider, model),
      before = JSON.stringify(f)
    const facts = assertStructuredJourney(f.snapshot, f.observed, f.expected)
    assert.equal(facts.actualModelMatched, true)
    assert.equal(facts.authoritativeStructuredResult, true)
    assert.equal(JSON.stringify(f), before, 'observer and durable facts must never be renamed')
  })
}
for (const provider of ['', 'DeepSeek', 'deepseek ', 'zai', 'blueprint-live', null, 42])
  test(`R-C01 illegal explicit provider ${String(provider)} is typed fail-closed`, () => {
    rejects(() => configuration(selectedEnv(provider, 'deepseek-flash')), 'LIVE_BUILTIN_PROVIDER_UNSUPPORTED')
  })
for (const field of ['BP_LIVE_PROVIDER_KEY', 'BP_LIVE_PROVIDER_MODEL'])
  test(`R-C01 missing ${field} is not-run, not an import/fixture failure`, () => {
    const env = selectedEnv('deepseek', 'deepseek-flash')
    delete env[field]
    assert.throws(
      () => configuration(env),
      error => error.reasonCode === 'LIVE_CONFIGURATION_MISSING'
    )
    env[field] = '   '
    assert.throws(
      () => configuration(env),
      error => error.reasonCode === 'LIVE_CONFIGURATION_MISSING'
    )
  })
for (const [field, value] of [
  ['BP_LIVE_PROVIDER_BASE_URL', 'https://api.deepseek.com'],
  ['BP_LIVE_PROVIDER_BASE_URL', ''],
  ['BP_LIVE_PROVIDER_PROTOCOL', 'openai-completions'],
  ['BP_LIVE_PROVIDER_PROTOCOL', 'openai_chat_completions'],
  ['BP_LIVE_PROVIDER_PROTOCOL', '']
]) {
  test(`R-C01 explicit ${field} override is rejected, even when it matches the catalog (${value})`, () => {
    rejects(() => configuration({ ...selectedEnv('deepseek', 'deepseek-flash'), [field]: value }), 'LIVE_BUILTIN_OVERRIDE_FORBIDDEN')
  })
}
for (const model of ['missing-model', 'glm-5.3-flash', 'deepseek-flash '])
  test(`R-C01 unavailable or nonexact model ${model} is rejected`, () => {
    rejects(() => selectedConfig('deepseek', model), 'LIVE_BUILTIN_MODEL_UNAVAILABLE')
  })
test('R-C01 synthetic credential checks remain in the builtin path', () => {
  rejects(() => configuration({ ...selectedEnv('deepseek', 'deepseek-flash'), BP_LIVE_PROVIDER_KEY: 'synthetic-not-live' }), 'LIVE_SYNTHETIC_CREDENTIAL')
})
for (const [field, value, code] of [
  ['baseUrl', 'https://override.invalid', 'LIVE_BUILTIN_CONFIG_MISMATCH'],
  ['protocol', 'anthropic-messages', 'LIVE_BUILTIN_CONFIG_MISMATCH'],
  ['model', 'missing-model', 'LIVE_BUILTIN_MODEL_UNAVAILABLE'],
  ['provider', 'unknown', 'LIVE_BUILTIN_PROVIDER_UNSUPPORTED'],
  ['api', 'openai-completions', 'LIVE_BUILTIN_OVERRIDE_FORBIDDEN'],
  ['baseURL', 'https://api.deepseek.com', 'LIVE_BUILTIN_OVERRIDE_FORBIDDEN'],
  ['models', [], 'LIVE_BUILTIN_OVERRIDE_FORBIDDEN']
]) {
  test(`R-C01 revalidated config cannot introduce ${field} overrides`, async () => {
    const config = { ...selectedConfig(), [field]: value }
    rejects(() => revalidateConfiguration(config), code)
    rejects(() => profilePatch({ ...patchArgs, liveConfig: config }), code)
    await assert.rejects(
      () => runIsolatedJourney({}, config),
      error => error.code === code
    )
    await assert.rejects(
      () => runIsolatedStructured(config, {}),
      error => error.code === code
    )
  })
}
test('R-C01 legacy default config/profile and synthetic-negative environment remain custom', () => {
  const config = configuration({ BP_LIVE_PROVIDER_KEY: KEY, BP_LIVE_PROVIDER_MODEL: 'custom-model', BP_LIVE_PROVIDER_BASE_URL: 'https://provider.invalid/v1/' })
  assert.deepEqual(config, { key: KEY, baseUrl: 'https://provider.invalid/v1', model: 'custom-model', protocol: 'openai-completions' })
  assert.deepEqual(revalidateConfiguration(config), config)
  assert.equal(profilePatch(patchArgs), profilePatch({ ...patchArgs, liveConfig: config }))
  assert.match(profilePatch(patchArgs), /providers:\n      blueprint-live:/)
  const synthetic = { key: 'synthetic-W4-do-not-archive', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', protocol: 'openai-completions' }
  const env = isolatedEnvironment('/isolated', synthetic, {})
  assert.equal(env.BP_LIVE_PROVIDER_BASE_URL, synthetic.baseUrl)
  assert.equal(env.BP_LIVE_PROVIDER_PROTOCOL, synthetic.protocol)
  assert.equal(env.BP_LIVE_BUILTIN_PROVIDER, undefined)
  const f = fixture('blueprint-live', 'fixture-model')
  delete f.expected.provider
  assert.equal(assertStructuredJourney(f.snapshot, f.observed, f.expected).actualModelMatched, true)
})
for (const field of ['request_provider_sha256', 'request_model_sha256'])
  test(`R-C02 mismatched observer ${field} is not accepted by durable metadata`, () => {
    const f = fixture()
    f.observed.sessions[0][field] = sha256('foreign-route')
    rejects(() => assertStructuredJourney(f.snapshot, f.observed, f.expected), 'STRUCTURED_MODEL_MISMATCH')
  })
for (const field of ['provider', 'model'])
  test(`R-C02 mismatched durable ${field} is not accepted by observer facts`, () => {
    const f = fixture()
    f.snapshot.attempts[0].diagnostics.modelSelection[field] = 'foreign-route'
    rejects(() => assertStructuredJourney(f.snapshot, f.observed, f.expected), 'STRUCTURED_MODEL_MISMATCH')
  })
for (const provider of ['blueprint-live', 'zai-coding-cn', 'foreign', '', null])
  test(`R-C02 expected-provider mismatch ${String(provider)} never renames facts`, () => {
    const f = fixture()
    f.expected.provider = provider
    rejects(() => assertStructuredJourney(f.snapshot, f.observed, f.expected), 'STRUCTURED_MODEL_MISMATCH')
  })
test('R-C02 self-consistent builtin facts cannot authorize a model absent from the installed catalog', () => {
  const f = fixture('deepseek', 'absent-model')
  rejects(() => assertStructuredJourney(f.snapshot, f.observed, f.expected), 'STRUCTURED_MODEL_MISMATCH')
})
const negativeMutations = [
  [
    'authority missing',
    f => {
      f.observed.sessions[0].authoritativeResultCount = 0
    },
    'STRUCTURED_AUTHORITY_MISSING'
  ],
  [
    'terminal incomplete',
    f => {
      f.observed.sessions[0].completed = false
    },
    'STRUCTURED_TERMINAL_INCOMPLETE'
  ],
  [
    'disposed missing',
    f => {
      f.observed.sessions[0].disposed = false
    },
    'STRUCTURED_TERMINAL_INCOMPLETE'
  ],
  [
    'accepted absent',
    f => {
      delete f.snapshot.attempts[0].diagnostics.acceptance
    },
    'STRUCTURED_ACCEPTANCE_MISMATCH'
  ],
  [
    'accepted alias rejected',
    f => {
      f.snapshot.attempts[0].diagnostics.acceptance.code = 'schema-valid'
    },
    'STRUCTURED_ACCEPTANCE_MISMATCH'
  ],
  [
    'schema missing',
    f => {
      delete f.snapshot.attempts[0].diagnostics.resourceDigests.answerSchema
    },
    'STRUCTURED_SCHEMA_DIGEST_MISMATCH'
  ],
  [
    'frozen resource missing',
    f => {
      delete f.snapshot.attempts[0].diagnostics.resourceDigests.worker
    },
    'STRUCTURED_AGENT_DIGEST_MISMATCH'
  ],
  [
    'package digest missing',
    f => {
      delete f.snapshot.attempts[0].diagnostics.resourceDigests.$package
    },
    'STRUCTURED_AGENT_DIGEST_MISMATCH'
  ],
  [
    'input changed',
    f => {
      f.snapshot.attempts[0].diagnostics.input.sha256 = sha256('different-input')
    },
    'STRUCTURED_INPUT_DIGEST_MISMATCH'
  ],
  [
    'tools policy changed',
    f => {
      f.snapshot.attempts[0].diagnostics.tools.effectiveNames = ['unexpected']
    },
    'STRUCTURED_TOOL_POLICY_MISMATCH'
  ],
  [
    'nonce changed',
    f => {
      f.snapshot.attempts[0].outputJson = JSON.stringify({ outputs: { payload: { nonce: 'wrong' } } })
    },
    'STRUCTURED_OUTPUT_MISMATCH'
  ],
  [
    'downstream changed',
    f => {
      f.snapshot.attempts[1].state = 'failed'
    },
    'STRUCTURED_DOWNSTREAM_MISMATCH'
  ]
]
for (const [label, mutate, code] of negativeMutations)
  test(`R-C02 ${label} still fails in the builtin path`, () => {
    const f = fixture()
    mutate(f)
    rejects(() => assertStructuredJourney(f.snapshot, f.observed, f.expected), code)
  })
const receiptSpec = () => ({
  reportDir: '/isolated/report',
  cwd: '/workspace/blueprint',
  before: { revision: 'a'.repeat(40), source_sha256: 'b'.repeat(64), artifact_sha256: 'c'.repeat(64) },
  after: { revision: 'a'.repeat(40), source_sha256: 'b'.repeat(64), artifact_sha256: 'c'.repeat(64) },
  identity: { os: 'darwin', arch: 'arm64', osRelease: '25.0', node: 'v24.11.1', dshVersion: '0.2.1-rc.2' },
  result: { status: 'not-run', code: 'LIVE_CONFIGURATION_MISSING', exit_code: 2 },
  protocol: 'openai-completions'
})
test('R-C02 receipts allow only exact builtin/legacy provider identities and retain original fact whitelist', () => {
  assert.equal(createReceipt(receiptSpec()).provider, 'blueprint-live')
  for (const provider of ['blueprint-live', 'deepseek', 'zai-coding-cn']) {
    const receipt = createReceipt({ ...receiptSpec(), provider, assertions: { key: KEY, rawBody: KEY } })
    assert.equal(receipt.provider, provider)
    assert.equal(receipt.status, 'not-run')
    assert.equal(receipt.exit_code, 2)
    assert.deepEqual(receipt.budgets_ms, { agent: null, observer: 30000 })
    assert.equal(JSON.stringify(receipt).includes(KEY), false)
  }
  for (const provider of ['unknown', '', null]) rejects(() => createReceipt({ ...receiptSpec(), provider }), 'STRUCTURED_MODEL_MISMATCH')
  const code = 'LIVE_BUILTIN_OVERRIDE_FORBIDDEN'
  let error
  try {
    configuration({ ...selectedEnv('deepseek', 'deepseek-flash'), BP_LIVE_PROVIDER_BASE_URL: KEY })
  } catch (caught) {
    error = caught
  }
  assert.deepEqual(classifyFailure(error), { status: 'failed', code, exit_code: 1 })
})
test('R-C02 explicit diagnostic budget only: shared environment strips all ambient injection', () => {
  const config = selectedConfig(),
    source = {
      PATH: '/bin',
      NODE_OPTIONS: '--import ambient-secret',
      BP_LIVE_DIAGNOSTIC_BUDGET_FILE: '/ambient-budget',
      BP_LIVE_BUILTIN_PROVIDER: 'foreign',
      DEEPSEEK_API_KEY: KEY,
      ZAI_API_KEY: KEY
    }
  const plain = isolatedJourneyEnvironment('/isolated', config, undefined, source)
  assert.equal(plain.NODE_OPTIONS, undefined)
  assert.equal(plain.BP_LIVE_DIAGNOSTIC_BUDGET_FILE, undefined)
  assert.equal(plain.DEEPSEEK_API_KEY, undefined)
  assert.equal(plain.ZAI_API_KEY, undefined)
  assert.equal(plain.BP_LIVE_BUILTIN_PROVIDER, 'deepseek')
  const env = isolatedJourneyEnvironment('/isolated', config, { preloadPath: '/isolated/pre load.mjs', reportPath: '/isolated/budget.json' }, source)
  assert.equal(env.NODE_OPTIONS, '--import file:///isolated/pre%20load.mjs')
  assert.equal(env.BP_LIVE_DIAGNOSTIC_BUDGET_FILE, '/isolated/budget.json')
  for (const malformed of [null, {}, { preloadPath: 'relative', reportPath: '/abs' }, { preloadPath: '/abs', reportPath: 'relative' }]) {
    assert.throws(() => isolatedJourneyEnvironment('/isolated', config, malformed, source), { name: 'TypeError', message: 'invalid diagnostic budget paths' })
  }
  assert.equal(typeof runIsolatedStructured, 'function')
  for (const name of ['journey.mjs', 'runtime-contracts-journey.mjs']) {
    const body = readFileSync(new URL(`../live/${name}`, import.meta.url), 'utf8')
    assert.match(body, /isolatedJourneyEnvironment\(home, config, diagnosticBudget\)/)
    assert.match(body, /observerModule: observer, toolIds, liveConfig: config/)
    assert.match(body, /config = revalidateConfiguration\(config\)/)
  }
  const structured = readFileSync(new URL('../live/runtime-contracts-journey.mjs', import.meta.url), 'utf8')
  assert.match(structured, /export async function runIsolatedStructured\(config, progress, \{ diagnosticBudget \} = \{\}\)/)
  assert.match(structured, /Object.assign\(progress, facts\)\n    return facts/)
  assert.match(structured, /const OBSERVATION_MS = 30000/)
})
