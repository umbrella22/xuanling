// Synthetic/public-observation validator only. It never boots DSH, reads key/,
// calls a provider, or treats a screenshot/DOM node as native Team evidence.

export const TEAMSTAGE_BROWSER_STATUS = Object.freeze({
  PASSED: 'passed',
  NOT_RUN: 'not_run',
  UNVERIFIED: 'UNVERIFIED',
})

const IDENTITY_FIELDS = ['runId', 'attemptId', 'stageId', 'teamId', 'taskId', 'sourceSessionId']
const MEMBER_STATUSES = new Set(['provisioning', 'active', 'running', 'inactive', 'failed', 'completed', 'cancelled'])
const APPROVAL_OUTCOMES = new Set(['allowed-once', 'allowed', 'denied'])
const MUTATING_METHODS = /(?:^|\/)(?:startTeamStage|cancelTeamStage|acceptTeamStageOutput|startSessionRun|prompt|cancel|decide|updateQueue)$/
const SECRET_KEY_NAMES = new Set([
  'raw', 'prompt', 'rawprompt', 'body', 'rawbody', 'content', 'arguments',
  'credential', 'credentials', 'apikey', 'authorization', 'cookie', 'secret',
  'modeltext', 'providerbody', 'rawproviderbody',
])
const SECRET_VALUE = [
  /BP[_-]?SECRET[_-]?CANARY/i,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bBearer\s+[A-Za-z0-9._-]{12,}/i,
  /\b(?:authorization|api[_-]?key|password|cookie)\s*[:=]/i,
]

function reject(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function unverified(code, missing = []) {
  return { status: TEAMSTAGE_BROWSER_STATUS.UNVERIFIED, code, missing: [...missing] }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function forbiddenKey(key) {
  return SECRET_KEY_NAMES.has(key.replace(/[-_]/g, '').toLowerCase())
}

function scanForbidden(value, path = '$', seen = new Set()) {
  if (typeof value === 'string') {
    if (SECRET_VALUE.some(pattern => pattern.test(value))) throw reject('TEAMSTAGE_SECRET_PRESENT', `forbidden secret material at ${path}`)
    return
  }
  if (!value || typeof value !== 'object') return
  if (seen.has(value)) throw reject('TEAMSTAGE_RECEIPT_CYCLE', `cyclic receipt at ${path}`)
  seen.add(value)
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKey(key)) throw reject('TEAMSTAGE_SECRET_PRESENT', `forbidden field at ${path}.${key}`)
    scanForbidden(child, `${path}.${key}`, seen)
  }
  seen.delete(value)
}

function missingIdentity(identity) {
  return IDENTITY_FIELDS.filter(field => !nonEmpty(identity?.[field]))
}

function sameIdentity(left, right) {
  return IDENTITY_FIELDS.every(field => left?.[field] === right?.[field])
}

function validateTeamBinding(receipt, identity) {
  const team = receipt.team
  if (!team) return unverified('TEAMSTAGE_NATIVE_TEAM_EVIDENCE_MISSING', ['team'])
  const teamMissing = missingIdentity(team)
  if (teamMissing.length > 0) return unverified('TEAMSTAGE_NATIVE_TEAM_EVIDENCE_MISSING', teamMissing.map(field => `team.${field}`))
  if (!sameIdentity(team, identity)) throw reject('TEAMSTAGE_FOREIGN_BINDING', 'Team binding does not match canonical identity')
  const task = receipt.task
  if (!task) return unverified('TEAMSTAGE_NATIVE_TEAM_EVIDENCE_MISSING', ['task'])
  const taskMissing = missingIdentity(task)
  if (taskMissing.length > 0 || !Number.isInteger(task.nativeRevision) || task.nativeRevision < 1) {
    return unverified('TEAMSTAGE_NATIVE_TEAM_EVIDENCE_MISSING', [...taskMissing.map(field => `task.${field}`), 'task.nativeRevision'])
  }
  if (!sameIdentity(task, identity)) throw reject('TEAMSTAGE_FOREIGN_BINDING', 'Task binding does not match canonical identity')
  if (!Array.isArray(team.memberNativeIds) || team.memberNativeIds.length === 0) {
    return unverified('TEAMSTAGE_NATIVE_TEAM_EVIDENCE_MISSING', ['team.memberNativeIds'])
  }
  if (!Array.isArray(receipt.members) || receipt.members.length === 0) {
    return unverified('TEAMSTAGE_NATIVE_TEAM_EVIDENCE_MISSING', ['members'])
  }
  const nativeIds = []
  const logicalIds = []
  for (const member of receipt.members) {
    if (!nonEmpty(member?.logicalId) || !nonEmpty(member?.nativeId) || !MEMBER_STATUSES.has(member.status)) {
      return unverified('TEAMSTAGE_NATIVE_TEAM_EVIDENCE_MISSING', ['members.logicalId', 'members.nativeId', 'members.status'])
    }
    if (member.teamId !== identity.teamId || member.taskId !== identity.taskId || member.stageId !== identity.stageId) {
      throw reject('TEAMSTAGE_FOREIGN_BINDING', 'Member binding does not match canonical TeamStage identity')
    }
    nativeIds.push(member.nativeId); logicalIds.push(member.logicalId)
  }
  if (new Set(nativeIds).size !== nativeIds.length || new Set(logicalIds).size !== logicalIds.length
    || nativeIds.length !== team.memberNativeIds.length
    || nativeIds.some(nativeId => !team.memberNativeIds.includes(nativeId))) {
    throw reject('TEAMSTAGE_FOREIGN_BINDING', 'Member native identity set does not match Team binding')
  }
  return null
}

function validateExecution(receipt) {
  if (receipt?.execution?.automatic !== true
    || receipt.execution.nodeKind !== 'agentTask'
    || receipt.execution.stageKind !== 'teamStage') {
    return { status: TEAMSTAGE_BROWSER_STATUS.NOT_RUN, code: 'TEAMSTAGE_AUTOMATIC_NOT_RUN', missing: ['automatic agentTask.teamStage'] }
  }
  if (receipt.browserEvidence !== true || receipt.providerEvidence !== true || receipt.provider?.live !== true) {
    return unverified('TEAMSTAGE_LIVE_PROVIDER_NOT_RUN', ['browserEvidence', 'providerEvidence', 'provider.live'])
  }
  return null
}

export function validateTeamStageBrowserReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw reject('TEAMSTAGE_RECEIPT_INVALID', 'receipt must be an object')
  scanForbidden(receipt)
  if (receipt.schemaVersion !== 1 || receipt.planId !== 'dsh-blueprint-teamstage-v1' || receipt.status !== 'passed') {
    throw reject('TEAMSTAGE_RECEIPT_INVALID', 'receipt header is not an accepted TeamStage browser receipt')
  }
  const early = validateExecution(receipt)
  if (early) return early
  const identityMissing = missingIdentity(receipt.identity)
  if (identityMissing.length > 0) return unverified('TEAMSTAGE_CANONICAL_IDS_MISSING', identityMissing)
  const identity = receipt.identity

  const teamResult = validateTeamBinding(receipt, identity)
  if (teamResult) return teamResult
  if (receipt.source?.sessionId !== identity.sourceSessionId) throw reject('TEAMSTAGE_FOREIGN_BINDING', 'source session does not match canonical identity')
  if (!nonEmpty(receipt.source?.kind)) return unverified('TEAMSTAGE_SOURCE_EVIDENCE_MISSING', ['source.kind'])

  const provider = receipt.provider
  if (!nonEmpty(provider?.name) || !nonEmpty(provider?.model) || !nonEmpty(provider?.protocol)) {
    return unverified('TEAMSTAGE_LIVE_PROVIDER_NOT_RUN', ['provider.name', 'provider.model', 'provider.protocol'])
  }
  const stream = receipt.stream
  if (!nonEmpty(stream?.requestIdentity) || !Number.isInteger(stream.requestCount) || stream.requestCount < 1
    || !Array.isArray(stream.requestIdentities) || stream.requestIdentities.length !== stream.requestCount
    || !stream.requestIdentities.every(nonEmpty)
    || new Set(stream.requestIdentities).size !== stream.requestIdentities.length
    || !stream.requestIdentities.includes(stream.requestIdentity) || stream.mutationDelta !== 0) {
    return unverified('TEAMSTAGE_STREAM_EVIDENCE_MISSING', ['stream.requestIdentity', 'stream.requestCount', 'stream.mutationDelta'])
  }

  if (!receipt.approval || !receipt.toolLineage
    || !nonEmpty(receipt.approval.auditId) || !nonEmpty(receipt.approval.callId)
    || !APPROVAL_OUTCOMES.has(receipt.approval.outcome) || receipt.approval.outcome === 'denied'
    || !nonEmpty(receipt.toolLineage.name)
    || receipt.toolLineage.callId !== receipt.approval.callId
    || receipt.toolLineage.resultObserved !== true) {
    return unverified('TEAMSTAGE_APPROVAL_TOOL_LINEAGE_MISSING', ['approval.auditId', 'approval.callId', 'toolLineage'])
  }

  const restart = receipt.restart
  if (!restart?.before || !restart.after || !sameIdentity(restart.before, identity) || !sameIdentity(restart.after, identity)
    || restart.mutationDelta !== 0) {
    return unverified('TEAMSTAGE_RESTART_EVIDENCE_MISSING', ['restart.before', 'restart.after', 'restart.mutationDelta'])
  }

  const artifact = receipt.artifact
  if (!/^[a-f0-9]{64}$/.test(artifact?.sha256 ?? '') || !artifact.provenance
    || !sameIdentity(artifact.provenance, identity)
    || !receipt.members.some(member => member.nativeId === artifact.provenance.memberNativeId)) {
    return unverified('TEAMSTAGE_ARTIFACT_EVIDENCE_MISSING', ['artifact.sha256', 'artifact.provenance'])
  }

  if (!Array.isArray(receipt.requests) || receipt.requests.length === 0) {
    return unverified('TEAMSTAGE_NATIVE_REQUEST_OBSERVATION_MISSING', ['requests'])
  }
  for (const request of receipt.requests) {
    if (!nonEmpty(request?.method)) {
      throw reject('TEAMSTAGE_REQUEST_OBSERVATION_INVALID', 'request observation has no method')
    }
    if (request.mutation === true || MUTATING_METHODS.test(request.method)) {
      throw reject('TEAMSTAGE_MUTATION_OBSERVED', 'mutating request observed in browser evidence')
    }
    if (request.mutation !== false) {
      throw reject('TEAMSTAGE_REQUEST_OBSERVATION_INVALID', 'request observation is missing an explicit read-only marker')
    }
  }
  return { status: TEAMSTAGE_BROWSER_STATUS.PASSED, code: 'TEAMSTAGE_BROWSER_RECEIPT_VALID', ...identity }
}
