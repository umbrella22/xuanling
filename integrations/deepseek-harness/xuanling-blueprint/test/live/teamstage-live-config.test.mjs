import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLiveTeamStageProfileOverlay,
  classifyTeamStageLiveNotRun,
  parseTeamStageCollectorConfiguration,
  redactTeamStageLiveConfiguration,
  TeamStageLiveConfigurationError,
} from '../../../../../test/blueprint/capabilities/teamstage-live.mjs'

const liveArgs = [
  '--mode', 'live',
  '--provider', 'DeepSeek',
  '--model', 'deepseek-flash',
  '--protocol', 'openai-responses',
  '--key-file', '/tmp/isolated-live-key.txt',
  '--base-url', 'https://api.deepseek.ai/v1',
]

function errorCode(run) {
  assert.throws(run, error => error instanceof TeamStageLiveConfigurationError)
  try { run() } catch (error) { return error.code }
  return undefined
}

test('live configuration without an explicit provider is typed missing, never fixture fallback', () => {
  assert.equal(errorCode(() => parseTeamStageCollectorConfiguration(['--mode', 'live'], {})), 'LIVE_TEAM_CONFIGURATION_MISSING')
})

test('fixture mode is explicit in the absence of live mode and has no provider fields', () => {
  assert.deepEqual(parseTeamStageCollectorConfiguration([], {}), { mode: 'fixture' })
  assert.deepEqual(parseTeamStageCollectorConfiguration(['--two-members', '--fork-collaborator'], {}), { mode: 'fixture' })
})

test('duplicate CLI and conflicting environment configuration are rejected', () => {
  assert.equal(errorCode(() => parseTeamStageCollectorConfiguration(['--mode', 'live', '--mode', 'live'], {})), 'LIVE_TEAM_CONFIGURATION_DUPLICATE')
  assert.equal(errorCode(() => parseTeamStageCollectorConfiguration(liveArgs, { BP_LIVE_TEAM_MODEL: 'glm-5.3-flash' })), 'LIVE_TEAM_CONFIGURATION_DUPLICATE')
  assert.equal(errorCode(() => parseTeamStageCollectorConfiguration(['--mode', 'live', '--unknown', 'value'], {})), 'LIVE_TEAM_CONFIGURATION_INVALID')
})

test('invalid URL and provider/model or provider/protocol mismatch are rejected', () => {
  assert.equal(errorCode(() => parseTeamStageCollectorConfiguration(liveArgs.map(value => value === 'https://api.deepseek.ai/v1' ? 'http://127.0.0.1:8080' : value), {})), 'LIVE_TEAM_CONFIGURATION_INVALID')
  assert.equal(errorCode(() => parseTeamStageCollectorConfiguration(liveArgs.map(value => value === 'deepseek-flash' ? 'glm-5.3-flash' : value), {})), 'LIVE_TEAM_CONFIGURATION_PROVIDER_MODEL_MISMATCH')
  assert.equal(errorCode(() => parseTeamStageCollectorConfiguration(liveArgs.map(value => value === 'openai-responses' ? 'anthropic-messages' : value), {})), 'LIVE_TEAM_CONFIGURATION_PROVIDER_PROTOCOL_MISMATCH')
})

test('live profile overlay uses public DSH seams and never carries credential bytes', () => {
  const config = parseTeamStageCollectorConfiguration(liveArgs, {})
  const overlay = buildLiveTeamStageProfileOverlay(config)
  const redacted = redactTeamStageLiveConfiguration(config)
  const encoded = JSON.stringify({ overlay, redacted })

  assert.equal(overlay.runtime.surface, 'public-agent-team')
  assert.equal(overlay.runtime.requiresNativeTeamProfile, true)
  assert.equal(overlay.runtime.syntheticModel, false)
  assert.equal(overlay.runtime.directProviderHttp, false)
  assert.deepEqual(overlay.bundles, ['@deepseek-ai/dsh-experimental-agent-team-profile'])
  assert.equal(overlay.environment.BP_LIVE_TEAM_PROVIDER_KEY_FILE, '/tmp/isolated-live-key.txt')
  assert.equal(redacted.key_file, '<provided>')
  assert.equal(redacted.key_read, false)
  assert.equal(redacted.provider_calls, 0)
  assert.doesNotMatch(encoded, /sk-[A-Za-z0-9_-]{20,}/)
  assert.doesNotMatch(encoded, /Authorization|authorization|secret-value|raw-provider-body/)
})

test('not-run classification is explicit and cannot be mistaken for provider success', () => {
  assert.deepEqual(classifyTeamStageLiveNotRun('LIVE_TEAM_RUNTIME_NOT_EXECUTED'), {
    status: 'not_run', code: 'LIVE_TEAM_RUNTIME_NOT_EXECUTED', detail: 'live TeamStage runtime was not executed', live_provider: true, provider_calls: 0, key_read: false,
  })
})

test('live provider overlay delegates stream idle timeout to native DSH configuration', () => {
  const overlay = buildLiveTeamStageProfileOverlay(parseTeamStageCollectorConfiguration(liveArgs, {}))
  const provider = overlay.patch.find(entry => entry.id === 'llm-pi-ai').config.providers['blueprint-live']
  assert.equal(Object.hasOwn(provider, 'streamIdleTimeoutMs'), false,
    'the collector must not override the native provider idle policy with its own short budget')
})
