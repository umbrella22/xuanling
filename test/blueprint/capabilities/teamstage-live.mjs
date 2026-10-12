/**
 * Configuration boundary for a future live TeamStage collector.
 *
 * This module deliberately does not read credentials, start DSH, call a
 * provider, or provide a synthetic model. It only validates an explicit live
 * configuration and describes the public DSH profile seam that a main-owned
 * collector may use later.
 */

const LIVE_FLAGS = Object.freeze({
  '--mode': 'mode',
  '--provider': 'provider',
  '--model': 'model',
  '--protocol': 'protocol',
  '--key-file': 'keyFile',
  '--base-url': 'baseUrl',
})

const LIVE_ENV = Object.freeze({
  mode: 'BP_LIVE_TEAM_MODE',
  provider: 'BP_LIVE_TEAM_PROVIDER',
  model: 'BP_LIVE_TEAM_MODEL',
  protocol: 'BP_LIVE_TEAM_PROTOCOL',
  keyFile: 'BP_LIVE_TEAM_KEY_FILE',
  baseUrl: 'BP_LIVE_TEAM_BASE_URL',
})

const LEGACY_FIXTURE_FLAGS = new Set(['--expect-unavailable', '--two-members', '--fork-collaborator'])

const PROVIDER_PROTOCOLS = Object.freeze({
  deepseek: Object.freeze(['openai-responses', 'openai-completions']),
  glm: Object.freeze(['anthropic-messages', 'openai-completions']),
})

const PROVIDER_MODEL_PREFIX = Object.freeze({ deepseek: 'deepseek-', glm: 'glm-' })
const PROTOCOLS = Object.freeze(['openai-completions', 'openai-responses', 'anthropic-messages'])

export class TeamStageLiveConfigurationError extends Error {
  constructor(code, details = {}) {
    super(code)
    this.name = 'TeamStageLiveConfigurationError'
    this.code = code
    this.details = details
  }
}

function fail(code, details) {
  throw new TeamStageLiveConfigurationError(code, details)
}

function value(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('LIVE_TEAM_CONFIGURATION_INVALID', { field })
  }
  return value
}

function parseArguments(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (LEGACY_FIXTURE_FLAGS.has(token)) continue
    const equal = token.indexOf('=')
    const flag = equal < 0 ? token : token.slice(0, equal)
    const field = LIVE_FLAGS[flag]
    if (field === undefined) fail('LIVE_TEAM_CONFIGURATION_INVALID', { field: flag })
    if (Object.hasOwn(parsed, field)) fail('LIVE_TEAM_CONFIGURATION_DUPLICATE', { field })
    const argument = equal < 0 ? argv[++index] : token.slice(equal + 1)
    if (argument === undefined || argument.startsWith('--')) fail('LIVE_TEAM_CONFIGURATION_MISSING', { field })
    parsed[field] = value(argument, field)
  }
  return parsed
}

function fromEnvironment(env) {
  const parsed = {}
  for (const [field, name] of Object.entries(LIVE_ENV)) {
    if (env[name] !== undefined && env[name] !== '') parsed[field] = value(env[name], field)
  }
  return parsed
}

function mergeSources(argumentsConfig, environmentConfig) {
  const merged = {}
  for (const field of Object.keys(LIVE_ENV)) {
    const argument = argumentsConfig[field]
    const environment = environmentConfig[field]
    if (argument !== undefined && environment !== undefined && argument !== environment) {
      fail('LIVE_TEAM_CONFIGURATION_DUPLICATE', { field })
    }
    if (argument !== undefined) merged[field] = argument
    else if (environment !== undefined) merged[field] = environment
  }
  return merged
}

function validateLiveConfig(config) {
  const missing = ['provider', 'model', 'protocol', 'keyFile', 'baseUrl'].filter(field => config[field] === undefined)
  if (missing.length > 0) fail('LIVE_TEAM_CONFIGURATION_MISSING', { fields: missing })

  const provider = config.provider.toLowerCase()
  if (!Object.hasOwn(PROVIDER_PROTOCOLS, provider)) fail('LIVE_TEAM_CONFIGURATION_INVALID', { field: 'provider' })
  if (!PROTOCOLS.includes(config.protocol) || !PROVIDER_PROTOCOLS[provider].includes(config.protocol)) {
    fail('LIVE_TEAM_CONFIGURATION_PROVIDER_PROTOCOL_MISMATCH', { provider, protocol: config.protocol })
  }
  if (!new RegExp(`^${PROVIDER_MODEL_PREFIX[provider]}`).test(config.model.toLowerCase())) {
    fail('LIVE_TEAM_CONFIGURATION_PROVIDER_MODEL_MISMATCH', { provider, model: config.model })
  }
  if (!/^(?:\/[\s\S]*|[A-Za-z]:[\\/][\s\S]*|\\\\[\s\S]*)$/.test(config.keyFile)) {
    fail('LIVE_TEAM_CONFIGURATION_INVALID', { field: 'keyFile' })
  }

  let url
  try { url = new URL(config.baseUrl) } catch { fail('LIVE_TEAM_CONFIGURATION_INVALID', { field: 'baseUrl' }) }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || ['localhost', '[::1]', '::1'].includes(url.hostname) || /^(?:127\.|0\.|169\.254\.)/.test(url.hostname)) {
    fail('LIVE_TEAM_CONFIGURATION_INVALID', { field: 'baseUrl' })
  }

  return Object.freeze({ mode: 'live', provider, model: config.model, protocol: config.protocol,
    keyFile: config.keyFile, baseUrl: url.href.replace(/\/$/, '') })
}

/** Parse explicit collector arguments. No arguments means the legacy fixture mode. */
export function parseTeamStageCollectorConfiguration(argv = [], env = process.env) {
  const argumentsConfig = parseArguments(argv)
  const environmentConfig = fromEnvironment(env)
  const config = mergeSources(argumentsConfig, environmentConfig)
  const mode = config.mode ?? 'fixture'
  if (mode === 'fixture') {
    if (Object.keys(config).some(field => field !== 'mode')) fail('LIVE_TEAM_CONFIGURATION_INVALID', { field: 'mode' })
    return Object.freeze({ mode: 'fixture' })
  }
  if (mode !== 'live') fail('LIVE_TEAM_CONFIGURATION_INVALID', { field: 'mode' })
  return validateLiveConfig(config)
}

/** Public DSH profile patch plan. It carries env indirections, never key bytes. */
export function buildLiveTeamStageProfileOverlay(config) {
  if (config?.mode !== 'live') fail('LIVE_TEAM_CONFIGURATION_MISSING', { field: 'mode' })
  return Object.freeze({
    bundles: Object.freeze(['@deepseek-ai/dsh-experimental-agent-team-profile']),
    environment: Object.freeze({
      BP_LIVE_TEAM_PROVIDER_KEY_FILE: config.keyFile,
      BP_LIVE_TEAM_PROVIDER_BASE_URL: config.baseUrl,
      BP_LIVE_TEAM_PROVIDER_MODEL: config.model,
      BP_LIVE_TEAM_PROVIDER_PROTOCOL: config.protocol,
    }),
    patch: Object.freeze([
      Object.freeze({ id: 'llm-pi-ai', config: Object.freeze({ providers: Object.freeze({
        'blueprint-live': Object.freeze({
          apiKeyEnv: 'BP_LIVE_TEAM_PROVIDER_KEY',
          api: '!!js process.env.BP_LIVE_TEAM_PROVIDER_PROTOCOL',
          baseURL: '!!js process.env.BP_LIVE_TEAM_PROVIDER_BASE_URL',
          models: Object.freeze([Object.freeze({
            id: '!!js process.env.BP_LIVE_TEAM_PROVIDER_MODEL',
            input: Object.freeze(['text']), reasoningEfforts: false, contextWindow: 32768, maxTokens: 2048,
          })]),
        }),
      }) }) }),
      Object.freeze({ id: 'agent-default-model', config: Object.freeze({
        provider: 'blueprint-live', model: '!!js process.env.BP_LIVE_TEAM_PROVIDER_MODEL',
      }) }),
    ]),
    runtime: Object.freeze({
      surface: 'public-agent-team',
      requiresNativeTeamProfile: true,
      syntheticModel: false,
      directProviderHttp: false,
    }),
  })
}

export function redactTeamStageLiveConfiguration(config) {
  return {
    mode: config?.mode ?? 'unknown',
    provider: config?.provider ?? null,
    model: config?.model ?? null,
    protocol: config?.protocol ?? null,
    base_url: config?.baseUrl ?? null,
    key_file: config?.keyFile === undefined ? null : '<provided>',
    key_read: false,
    provider_calls: 0,
  }
}

export function classifyTeamStageLiveNotRun(code = 'LIVE_TEAM_RUNTIME_NOT_EXECUTED', detail = 'live TeamStage runtime was not executed') {
  return Object.freeze({ status: 'not_run', code, detail, live_provider: true, provider_calls: 0, key_read: false })
}
