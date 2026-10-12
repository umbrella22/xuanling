// Installed public catalog only. Importing this helper does not read credentials,
// configure a real profile, start a Host, or dispatch a provider request.
// pi-ai's ./providers/* export is import-only; require.resolve cannot resolve
// it. This installed ESM artifact exposes the same public catalog function.
import { getBuiltinModels } from '../../../../../test/blueprint/node_modules/@earendil-works/pi-ai/dist/providers/all.js'
import { LiveJourneyError } from './live-diagnostic-evidence.mjs'
export const BUILTIN_PROVIDERS = Object.freeze(['deepseek', 'zai-coding-cn'])
export const BUILTIN_CONFIGURATION_ERROR_CODES = Object.freeze([
  'LIVE_BUILTIN_PROVIDER_UNSUPPORTED', 'LIVE_BUILTIN_MODEL_UNAVAILABLE',
  'LIVE_BUILTIN_OVERRIDE_FORBIDDEN', 'LIVE_BUILTIN_CONFIG_MISMATCH',
])
const fail = code => { throw new LiveJourneyError(code) }
export const isBuiltinProvider = provider => BUILTIN_PROVIDERS.includes(provider)

export function builtinModel(provider, model) {
  if (!isBuiltinProvider(provider)) fail('LIVE_BUILTIN_PROVIDER_UNSUPPORTED')
  const matches = getBuiltinModels(provider).filter(item => item.provider === provider && item.id === model)
  if (matches.length !== 1) fail('LIVE_BUILTIN_MODEL_UNAVAILABLE')
  const selected = matches[0]
  if (typeof selected.baseUrl !== 'string' || typeof selected.api !== 'string') fail('LIVE_BUILTIN_CONFIG_MISMATCH')
  return selected
}

export function builtinConfiguration(env, NotRun) {
  const provider = env.BP_LIVE_BUILTIN_PROVIDER
  if (!isBuiltinProvider(provider)) fail('LIVE_BUILTIN_PROVIDER_UNSUPPORTED')
  // An explicit builtin selection cannot silently consume a custom override,
  // even if that override happens to equal today's catalog value.
  if (env.BP_LIVE_PROVIDER_BASE_URL !== undefined || env.BP_LIVE_PROVIDER_PROTOCOL !== undefined) fail('LIVE_BUILTIN_OVERRIDE_FORBIDDEN')
  for (const name of ['BP_LIVE_PROVIDER_KEY', 'BP_LIVE_PROVIDER_MODEL']) {
    if (typeof env[name] !== 'string' || env[name].trim() === '') throw new NotRun('LIVE_CONFIGURATION_MISSING', 'builtin live provider key/model absent')
  }
  if (/^(placeholder|synthetic|test[-_]|fake[-_])/i.test(env.BP_LIVE_PROVIDER_KEY)) fail('LIVE_SYNTHETIC_CREDENTIAL')
  const selected = builtinModel(provider, env.BP_LIVE_PROVIDER_MODEL)
  return { key: env.BP_LIVE_PROVIDER_KEY, baseUrl: selected.baseUrl, model: selected.id, protocol: selected.api, provider }
}

// Direct runner callers must preserve exact catalog-derived route metadata.
// Do not convert the builtin identity into the legacy custom provider.
export function validateBuiltinConfiguration(config, NotRun) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('LIVE_BUILTIN_CONFIG_MISMATCH')
  if (Object.keys(config).some(key => !['key', 'baseUrl', 'model', 'protocol', 'provider'].includes(key))) fail('LIVE_BUILTIN_OVERRIDE_FORBIDDEN')
  const checked = builtinConfiguration({ BP_LIVE_BUILTIN_PROVIDER: config.provider,
    BP_LIVE_PROVIDER_KEY: config.key, BP_LIVE_PROVIDER_MODEL: config.model }, NotRun)
  if (config.baseUrl !== checked.baseUrl || config.protocol !== checked.protocol) fail('LIVE_BUILTIN_CONFIG_MISMATCH')
  return checked
}
