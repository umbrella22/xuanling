// Pure, secret-free projection for the ordinary live failure boundary.
// Only this class plus the exact journey vocabulary can preserve a reason.
export const LIVE_JOURNEY_ERROR_CODES = Object.freeze([
  'LIVE_PROTOCOL_UNSUPPORTED', 'LIVE_ENDPOINT_INVALID',
  'LIVE_SYNTHETIC_ENDPOINT', 'LIVE_SYNTHETIC_CREDENTIAL',
  'LIVE_GATEWAY_NOT_LOCAL', 'LIVE_GATEWAY_AUTH_FAILED',
  'LIVE_GATEWAY_METHOD_INVALID', 'LIVE_GATEWAY_RPC_FAILED',
  'LIVE_HOST_BOOT_TIMEOUT', 'LIVE_HOST_BOOT_FAILED', 'LIVE_HOST_EXITED',
  'LIVE_MODEL_ROUTE_MISSING', 'LIVE_PROMPT_MODEL_MISSING',
  'LIVE_PROVIDER_TIMEOUT', 'LIVE_PROVIDER_FAILED', 'LIVE_RUN_NOT_SUCCEEDED',
  'LIVE_AGENT_NONCE_MISSING', 'LIVE_DOWNSTREAM_NONCE_MISSING',
  'LIVE_AGENT_FACTS_MISSING', 'LIVE_SYNTHETIC_FIXTURE_INVALID',
  'LIVE_PLUGIN_NOT_MOUNTED', 'LIVE_RUN_ADMISSION_INVALID',
  'LIVE_RUN_OBSERVATION_TIMEOUT', 'LIVE_SYNTHETIC_SUCCESS_REJECTED',
  'LIVE_JOURNEY_FAILED',
])
const knownCodes = new Set(LIVE_JOURNEY_ERROR_CODES)
const trustedErrors = new WeakSet()

export class LiveJourneyError extends Error {
  constructor(code) {
    super(code)
    this.name = 'LiveJourneyError'
    this.code = code
    this.reason_code = code
    trustedErrors.add(this)
  }
}

export const LIVE_FAILURE_STAGES = Object.freeze([
  'initial', 'configuration_validated', 'artifacts_checked',
  'profile_prepared', 'host_launch_requested', 'gateway_ready',
  'gateway_authenticated', 'plugin_verified', 'definition_loaded',
  'run_admitted', 'run_observed', 'observer_read', 'journey_verified',
])
const stages = new Set(LIVE_FAILURE_STAGES)
// Public persisted Run / Attempt and inspectRun result vocabulary, not text.
const runStates = new Set(['queued', 'running', 'waiting_input', 'cancelling', 'recovery_required', 'succeeded', 'failed', 'cancelled', 'timed_out'])
const attemptStates = new Set(['preparing', 'ready', 'running', 'waiting_input', 'cancelling', 'recovery_required', 'succeeded', 'failed', 'cancelled', 'timed_out', 'skipped'])
const resultKinds = new Set(['succeeded', 'provider-failed', 'failed', 'timeout', 'cancelled', 'recovery_required', 'output-invalid', 'structured-output-missing'])
export const LIVE_OBSERVER_FLAGS = Object.freeze([
  'agentCreated', 'inboxSeen', 'scopedAgentSeen', 'requestSeen',
  'requestAborted', 'loopRequestSeen', 'responseSeen', 'completed', 'disposed',
])
// Exactly the codes already projected by the unmodified public observer.
export const LIVE_PROVIDER_FAILURE_CODES = Object.freeze([
  'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'HTTP_401', 'HTTP_403',
  'HTTP_404', 'HTTP_429', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504',
  'AUTHENTICATION', 'AUTHENTICATION_FAILED', 'INVALID_REQUEST',
  'MODEL_NOT_FOUND', 'RATE_LIMIT', 'NETWORK', 'PROVIDER_ERROR',
  'UNKNOWN', 'ABORTED', 'OTHER_TYPED_FAILURE',
])
const providerCodes = new Set(LIVE_PROVIDER_FAILURE_CODES)

// Read only own data properties: accessors/toJSON/raw objects never execute
// at this evidence boundary, and no unknown field is copied into the result.
const data = (value, key) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  } catch { return undefined }
}
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const status = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
const boolean = value => typeof value === 'boolean' ? value : null
const attemptProjection = value => ({
  state: attemptStates.has(data(value, 'state')) ? data(value, 'state') : 'unknown',
  resultKind: resultKinds.has(data(value, 'resultKind')) ? data(value, 'resultKind') : null,
})

/** Fixed schema only. Invalid values become unknown/null, never raw strings. */
export function projectLiveFailureEvidence(value) {
  if (data(value, 'schemaVersion') !== 1) return null
  const observer = data(value, 'observer')
  const provider = data(value, 'provider_failure')
  return {
    schemaVersion: 1,
    stage: stages.has(data(value, 'stage')) ? data(value, 'stage') : 'unknown',
    run_state: runStates.has(data(value, 'run_state')) ? data(value, 'run_state') : 'unknown',
    attempt_count: count(data(value, 'attempt_count')),
    model: attemptProjection(data(value, 'model')),
    downstream: attemptProjection(data(value, 'downstream')),
    session_count: count(data(value, 'session_count')),
    observer: Object.fromEntries(LIVE_OBSERVER_FLAGS.map(name => {
      const flag = data(observer, name)
      return [name, { seen: boolean(data(flag, 'seen')), count: count(data(flag, 'count')) }]
    })),
    provider_failure: {
      code: providerCodes.has(data(provider, 'code')) ? data(provider, 'code') : null,
      status: status(data(provider, 'status')),
    },
  }
}

/** Collect only actual snapshot / public observer facts, not error-code guesses.
 * null counts mean unavailable; zero counts mean a real observed empty set.
 */
export function collectLiveFailureEvidence(value) {
  const stage = data(value, 'stage'), snapshot = data(value, 'snapshot'), observed = data(value, 'observed')
  const rawAttempts = data(snapshot, 'attempts')
  const attempts = Array.isArray(rawAttempts) ? rawAttempts : null
  const rawSessions = data(observed, 'sessions')
  const sessions = Array.isArray(rawSessions) ? rawSessions : null
  const provider = sessions?.find(item => providerCodes.has(data(item, 'failureCode')) || status(data(item, 'failureStatus')) !== null)
  return projectLiveFailureEvidence({
    schemaVersion: 1, stage,
    run_state: data(snapshot, 'state'),
    attempt_count: attempts?.length ?? null,
    model: attempts?.find(item => data(item, 'nodeId') === 'model'),
    downstream: attempts?.find(item => data(item, 'nodeId') === 'downstream'),
    session_count: sessions?.length ?? null,
    observer: Object.fromEntries(LIVE_OBSERVER_FLAGS.map(name => {
      const seenCount = sessions === null ? null : sessions.filter(item => data(item, name) === true).length
      return [name, { seen: seenCount === null ? null : seenCount > 0, count: seenCount }]
    })),
    provider_failure: { code: data(provider, 'failureCode'), status: data(provider, 'failureStatus') },
  })
}

/** B entry / verify use this same trust boundary. Unknown stays generic. */
export function projectLiveJourneyFailure(error) {
  if (!trustedErrors.has(error) || !(error instanceof LiveJourneyError)) return null
  const code = data(error, 'code')
  if (!knownCodes.has(code)) return null
  const evidence = projectLiveFailureEvidence(data(error, 'failure_evidence'))
  return { reason_code: code, ...(evidence ? { failure_evidence: evidence } : {}) }
}
