// Public, non-secret receipt fields. Validation is not provenance/signature:
// a synthetic receipt is evaluator calibration, never a real live/OS claim.
export const LIVE_BEHAVIOR_FLAGS = Object.freeze([
  'runSucceeded', 'agentCreated', 'inboxSeen', 'scopedAgentSeen', 'requestSeen',
  'loopRequestSeen', 'responseSeen', 'completed', 'disposed', 'nonceMatched', 'downstreamMatched',
])
export const LIVE_BEHAVIOR_IDS = Object.freeze(['runId', 'attemptId', 'downstreamAttemptId', 'sessionId'])
export const LIVE_BEHAVIOR_HASHES = Object.freeze(['output_sha256', 'nonce_sha256'])
export const LIFECYCLE_BEHAVIOR_FLAGS = Object.freeze({
  PL1: Object.freeze(['packed']),
  PL2: Object.freeze(['profileInitialized']),
  PL3: Object.freeze(['installed', 'reconciled']),
  PL4: Object.freeze(['booted', 'blueprintPingSucceeded']),
  PL5: Object.freeze(['disabled', 'uninstalled']),
  PL6: Object.freeze(['baselineBundlesPreserved']),
  PL7: Object.freeze(['sourceUntouched', 'runtimeDataUntouched']),
})
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)

export function validLiveBehaviorDetail(detail) {
  if (!object(detail) || detail.ok !== true || !object(detail.behavior_assertions)) return false
  const facts = detail.behavior_assertions
  return LIVE_BEHAVIOR_IDS.every(key => identity(facts[key]))
    && facts.attemptId !== facts.downstreamAttemptId
    && facts.sessionId.startsWith(`bp-${facts.runId}-${facts.attemptId}-`)
    && facts.sessionId.length > `bp-${facts.runId}-${facts.attemptId}-`.length
    && LIVE_BEHAVIOR_FLAGS.every(key => facts[key] === true)
    && LIVE_BEHAVIOR_HASHES.every(key => hash(facts[key]))
    && facts.output_sha256 === facts.nonce_sha256
}

// Whitelist instead of serializing/truncating arbitrary provider output.
// Preserve complete IDs/digests, never silently normalize or truncate them.
export function selectLiveBehaviorDetail(value) {
  const facts = object(value?.behavior_assertions) ? value.behavior_assertions : {}
  return { ok: value?.ok === true, behavior_assertions: Object.fromEntries(
    [...LIVE_BEHAVIOR_IDS, ...LIVE_BEHAVIOR_FLAGS, ...LIVE_BEHAVIOR_HASHES]
      .filter(key => Object.hasOwn(facts, key)).map(key => [key, facts[key]]),
  ) }
}

export function validPlatformBehaviorDetail(detail, environment) {
  return object(detail) && detail.ok === true && typeof environment === 'string'
    && ['darwin', 'linux', 'win32'].includes(detail.platform)
    && typeof detail.arch === 'string' && /^[a-z0-9_]+$/.test(detail.arch)
    && `${detail.platform}/${detail.arch}` === environment
}

export function validLifecycleBehaviorDetail(detail, caseId, report) {
  const flags = LIFECYCLE_BEHAVIOR_FLAGS[caseId]
  const artifact = report?.artifacts?.tarball
  return Boolean(flags && object(detail) && detail.ok === true
    && ['web', 'headless'].includes(report?.mode) && report.mode === report.scope
    && detail.mode === report.mode && object(artifact)
    && typeof artifact.path === 'string' && artifact.path.trim() !== ''
    && hash(artifact.sha256) && detail.artifact_sha256 === artifact.sha256
    && object(detail.behavior_assertions)
    && flags.every(key => detail.behavior_assertions[key] === true))
}
