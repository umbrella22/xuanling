// Synthetic validator tests only. They never boot DSH, read key/, or call a provider.
import assert from 'node:assert/strict'
import test from 'node:test'

import { validateTeamStageBrowserReceipt } from './teamstage-browser.mjs'

const digest = 'a'.repeat(64)

function validReceipt() {
  const identity = {
    runId: 'run-teamstage-1',
    attemptId: 'attempt-teamstage-1',
    stageId: 'stage-teamstage-1',
    teamId: 'team-teamstage-1',
    taskId: 'task-teamstage-1',
    sourceSessionId: 'session-source-1',
  }
  return {
    schemaVersion: 1,
    planId: 'dsh-blueprint-teamstage-v1',
    status: 'passed',
    browserEvidence: true,
    providerEvidence: true,
    execution: { automatic: true, nodeKind: 'agentTask', stageKind: 'teamStage' },
    identity,
    team: { ...identity, memberNativeIds: ['native-member-1'] },
    task: { ...identity, nativeRevision: 1 },
    members: [{ logicalId: 'member-1', nativeId: 'native-member-1', teamId: identity.teamId,
      taskId: identity.taskId, stageId: identity.stageId, status: 'active' }],
    source: { sessionId: identity.sourceSessionId, kind: 'tool', callId: 'tool-call-1', turn: 3 },
    provider: { live: true, name: 'DeepSeek', model: 'deepseek-flash', protocol: 'openai-responses' },
    stream: { requestIdentity: 'provider-request-1', requestCount: 1, requestIdentities: ['provider-request-1'], mutationDelta: 0 },
    approval: { auditId: 'audit-1', callId: 'tool-call-1', outcome: 'allowed-once' },
    toolLineage: { name: 'blueprint_start', callId: 'tool-call-1', resultObserved: true },
    restart: { before: { ...identity, state: 'running' }, after: { ...identity, state: 'running' }, mutationDelta: 0 },
    artifact: { sha256: digest, provenance: { ...identity, memberNativeId: 'native-member-1' } },
    requests: [{ method: 'blueprint/inspectSession', mutation: false }, { method: 'session/projections', mutation: false }],
  }
}

test('humanDecision keyless graph is typed not_run, never TeamStage green', () => {
  const receipt = validReceipt()
  receipt.execution = { automatic: false, nodeKind: 'humanDecision', stageKind: null }
  receipt.providerEvidence = false
  receipt.provider.live = false
  const result = validateTeamStageBrowserReceipt(receipt)
  assert.equal(result.status, 'not_run')
  assert.equal(result.code, 'TEAMSTAGE_AUTOMATIC_NOT_RUN')
})

test('missing canonical Team IDs is typed UNVERIFIED', () => {
  const receipt = validReceipt()
  delete receipt.identity.teamId
  const result = validateTeamStageBrowserReceipt(receipt)
  assert.equal(result.status, 'UNVERIFIED')
  assert.equal(result.code, 'TEAMSTAGE_CANONICAL_IDS_MISSING')
})

test('missing native Team member/task evidence is typed UNVERIFIED', () => {
  const receipt = validReceipt()
  receipt.task = null
  const result = validateTeamStageBrowserReceipt(receipt)
  assert.equal(result.status, 'UNVERIFIED')
  assert.equal(result.code, 'TEAMSTAGE_NATIVE_TEAM_EVIDENCE_MISSING')
})

test('missing live provider flag is typed UNVERIFIED', () => {
  const receipt = validReceipt()
  receipt.provider.live = false
  receipt.providerEvidence = false
  const result = validateTeamStageBrowserReceipt(receipt)
  assert.equal(result.status, 'UNVERIFIED')
  assert.equal(result.code, 'TEAMSTAGE_LIVE_PROVIDER_NOT_RUN')
})

test('missing approval or tool lineage is typed UNVERIFIED', () => {
  const receipt = validReceipt()
  delete receipt.approval
  const result = validateTeamStageBrowserReceipt(receipt)
  assert.equal(result.status, 'UNVERIFIED')
  assert.equal(result.code, 'TEAMSTAGE_APPROVAL_TOOL_LINEAGE_MISSING')
})

test('denied approval cannot certify a passed TeamStage receipt', () => {
  const receipt = validReceipt()
  receipt.approval.outcome = 'denied'
  const result = validateTeamStageBrowserReceipt(receipt)
  assert.equal(result.status, 'UNVERIFIED')
  assert.equal(result.code, 'TEAMSTAGE_APPROVAL_TOOL_LINEAGE_MISSING')
})

test('foreign member or task binding is rejected', () => {
  const receipt = validReceipt()
  receipt.members[0].taskId = 'foreign-task'
  assert.throws(() => validateTeamStageBrowserReceipt(receipt), { code: 'TEAMSTAGE_FOREIGN_BINDING' })
})

test('observed mutation request is rejected', () => {
  const receipt = validReceipt()
  receipt.requests.push({ method: 'blueprint/startTeamStage', mutation: true })
  assert.throws(() => validateTeamStageBrowserReceipt(receipt), { code: 'TEAMSTAGE_MUTATION_OBSERVED' })
})

test('known mutation method is rejected even when falsely marked read-only', () => {
  const receipt = validReceipt()
  receipt.requests.push({ method: 'blueprint/startTeamStage', mutation: false })
  assert.throws(() => validateTeamStageBrowserReceipt(receipt), { code: 'TEAMSTAGE_MUTATION_OBSERVED' })
})

test('request without an explicit read-only marker is rejected', () => {
  const receipt = validReceipt()
  receipt.requests.push({ method: 'blueprint/createTask' })
  assert.throws(() => validateTeamStageBrowserReceipt(receipt), { code: 'TEAMSTAGE_REQUEST_OBSERVATION_INVALID' })
})

test('raw secret or prompt material is rejected', () => {
  const receipt = validReceipt()
  receipt.approval.rawPrompt = 'ordinary prompt text'
  assert.throws(() => validateTeamStageBrowserReceipt(receipt), { code: 'TEAMSTAGE_SECRET_PRESENT' })
})

test('underscore and camel-case sensitive field names are rejected before value scanning', () => {
  for (const field of ['raw_prompt', 'providerBody']) {
    const receipt = validReceipt()
    receipt.approval[field] = 'ordinary text'
    assert.throws(() => validateTeamStageBrowserReceipt(receipt), { code: 'TEAMSTAGE_SECRET_PRESENT' })
  }
})

test('complete automatic live TeamStage receipt is accepted by the strict validator', () => {
  assert.deepEqual(validateTeamStageBrowserReceipt(validReceipt()), {
    status: 'passed',
    code: 'TEAMSTAGE_BROWSER_RECEIPT_VALID',
    runId: 'run-teamstage-1',
    attemptId: 'attempt-teamstage-1',
    stageId: 'stage-teamstage-1',
    teamId: 'team-teamstage-1',
    taskId: 'task-teamstage-1',
    sourceSessionId: 'session-source-1',
  })
})

test('artifact provenance may bind to any declared native member', () => {
  const receipt = validReceipt()
  receipt.team.memberNativeIds.push('native-member-2')
  receipt.members.push({ logicalId: 'member-2', nativeId: 'native-member-2', teamId: receipt.identity.teamId,
    taskId: receipt.identity.taskId, stageId: receipt.identity.stageId, status: 'completed' })
  receipt.artifact.provenance.memberNativeId = 'native-member-2'
  assert.equal(validateTeamStageBrowserReceipt(receipt).status, 'passed')
})
