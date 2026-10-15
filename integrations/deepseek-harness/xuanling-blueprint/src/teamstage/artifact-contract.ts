/** Pure host artifact contracts shared by the byte store and canonical reducer. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { decodeDefinition } from '../definition/codec.ts'
import type { GraphNode } from '../definition/types.ts'
import { TEAM_KNOWN_CHECKS, type RunRecord, type TeamCaptureArtifactRef, type TeamMemberSnapshot, type TeamStageRecord } from '../persistence/records.ts'

export class TeamArtifactError extends Error {
  override readonly name = 'TeamArtifactError'
  readonly code = 'TEAM_OUTPUT_ARTIFACT_REJECTED'
  constructor(readonly issueCode: string) {
    super(issueCode)
  }
}
export function artifactReject(issue: string): never {
  throw new TeamArtifactError(issue)
}
export const artifactDigest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** JSON values only: no undefined, coerced Date/Buffer, lossy number or custom toJSON. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>()
  const encode = (item: unknown): string => {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item)
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item)
    if (typeof item !== 'object' || item === null || ancestors.has(item)) artifactReject('artifact-json-invalid')
    ancestors.add(item)
    try {
      if (Array.isArray(item)) {
        if (Object.keys(item).length !== item.length) artifactReject('artifact-json-invalid')
        return `[${Array.from({ length: item.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(item, index)
          if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) artifactReject('artifact-json-invalid')
          return encode(descriptor.value)
        }).join(',')}]`
      }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) artifactReject('artifact-json-invalid')
      if (Object.getOwnPropertySymbols(item).length) artifactReject('artifact-json-invalid')
      return `{${Object.keys(item)
        .sort()
        .map(key => {
          const descriptor = Object.getOwnPropertyDescriptor(item, key)!
          if (!Object.hasOwn(descriptor, 'value')) artifactReject('artifact-json-invalid')
          return `${JSON.stringify(key)}:${encode(descriptor.value)}`
        })
        .join(',')}}`
    } finally {
      ancestors.delete(item)
    }
  }
  return encode(value)
}

export function frozenArtifactNode(record: RunRecord): { node: GraphNode; stage: TeamStageRecord } {
  const stage = record.teamStage
  if (stage === undefined || stage.attemptId === undefined || stage.taskId === undefined) artifactReject('artifact-stage-binding-missing')
  let node: GraphNode | undefined
  try {
    node = decodeDefinition(record.definitionJson).graph.nodes.find(candidate => candidate.id === stage.stageId)
  } catch {
    artifactReject('artifact-frozen-definition-invalid')
  }
  if (node?.kind !== 'agentTask' || node.teamStage === undefined || node.outputSchemaRef === undefined) artifactReject('artifact-frozen-node-invalid')
  if (!record.attempts.some(attempt => attempt.attemptId === stage.attemptId && attempt.nodeId === node.id && attempt.intent !== undefined))
    artifactReject('artifact-attempt-binding-mismatch')
  return { node, stage }
}

export function requireArtifactStageWritable(record: RunRecord): void {
  const { stage } = frozenArtifactNode(record)
  if (
    !['queued', 'running', 'waiting_input'].includes(record.state) ||
    stage.cancel !== undefined ||
    stage.recovery !== undefined ||
    !['provisioning', 'active', 'waiting_input'].includes(stage.state)
  )
    artifactReject('artifact-stage-not-writable')
  const attempt = record.attempts.find(candidate => candidate.attemptId === stage.attemptId)!
  if (attempt.result !== undefined || !['preparing', 'ready', 'running', 'waiting_input'].includes(attempt.state))
    artifactReject('artifact-attempt-not-writable')
}

export function validateArtifactValue(schemaJson: string, schemaDigest: string, value: unknown): void {
  let schema: unknown
  try {
    schema = JSON.parse(schemaJson)
  } catch {
    artifactReject('artifact-schema-invalid')
  }
  if (artifactDigest(canonicalJson(schema)) !== schemaDigest || canonicalJson(schema) !== schemaJson) artifactReject('artifact-schema-binding-mismatch')
  try {
    assertObjectJsonSchema(schema)
  } catch {
    artifactReject('artifact-schema-invalid')
  }
  try {
    if (validateJsonSchemaValue(schema, value).length !== 0) artifactReject('artifact-schema-invalid')
  } catch {
    artifactReject('artifact-schema-invalid')
  }
}

export function captureEvidenceDigest(ref: Omit<TeamCaptureArtifactRef, 'evidenceDigest'>): string {
  return artifactDigest(canonicalJson(ref))
}

export function memberEvidenceForArtifact(ref: TeamCaptureArtifactRef): NonNullable<TeamMemberSnapshot['evidence']> {
  return {
    runId: ref.runId,
    stageId: ref.stageId,
    taskId: ref.taskId,
    attemptId: ref.attemptId,
    captureId: ref.artifactId,
    schemaDigest: ref.schemaDigest,
    valueDigest: ref.digest,
    completedTurnId: ref.evidence.completedTurnId,
    flushedAt: ref.evidence.flushedAt,
    quiescentAt: ref.evidence.quiescentAt
  }
}

/** Binding checks have no filesystem effects and are repeated inside serial RMW. */
export function validateCaptureArtifactBinding(record: RunRecord, ref: TeamCaptureArtifactRef, requireCurrentEvidence = true): void {
  const { node, stage } = frozenArtifactNode(record)
  if (
    ref.runId !== record.runId ||
    ref.definitionRevision !== record.definitionRevision ||
    ref.nodeId !== node.id ||
    ref.stageId !== stage.stageId ||
    ref.attemptId !== stage.attemptId ||
    ref.taskId !== stage.taskId ||
    ref.teamId !== stage.teamId
  )
    artifactReject('artifact-binding-mismatch')
  const reservation = stage.reservations?.find(item => item.memberId === ref.producerMemberId)
  const member = stage.members.find(item => item.memberId === ref.producerMemberId)
  if (
    reservation === undefined ||
    member === undefined ||
    member.phase !== 'active' ||
    ['running', 'failed', 'provisioning'].includes(member.status) ||
    reservation.runId !== record.runId ||
    reservation.stageId !== stage.stageId ||
    reservation.definitionRevision !== record.definitionRevision ||
    reservation.attemptId !== ref.attemptId ||
    member.sessionId !== ref.evidence.producerSessionId ||
    reservation.sessionId !== member.sessionId ||
    member.name !== reservation.nativeName ||
    member.logicalName !== reservation.logicalName ||
    ref.logicalName !== reservation.logicalName ||
    ref.nativeName !== reservation.nativeName ||
    ref.effectId !== reservation.effectId ||
    ref.reservationSeq !== reservation.reservationSeq ||
    ref.schemaDigest !== reservation.schemaDigest ||
    ref.schemaResourceId !== node.outputSchemaRef ||
    ref.schemaResourceId !== reservation.schemaResourceId ||
    ref.schemaResourceDigest !== reservation.schemaResourceDigest ||
    !isDeepStrictEqual(ref.resourceDigests, reservation.resourceDigests)
  )
    artifactReject('artifact-producer-binding-mismatch')
  const attempt = record.attempts.find(item => item.attemptId === stage.attemptId)!
  const declared = node.teamStage!.members.find(item => item.name === reservation.logicalName)
  if (
    declared === undefined ||
    reservation.schemaResourceId !== node.outputSchemaRef ||
    reservation.resourceDigests[declared.agentRef] === undefined ||
    attempt.intent?.resourceDigests[reservation.schemaResourceId] !== reservation.schemaResourceDigest ||
    reservation.resourceDigests[reservation.schemaResourceId] !== reservation.schemaResourceDigest ||
    artifactDigest(reservation.schemaCanonicalJson) !== reservation.schemaDigest
  )
    artifactReject('artifact-resource-binding-mismatch')
  for (const [id, digest] of Object.entries(reservation.resourceDigests)) {
    if (attempt.intent?.resourceDigests[id] !== undefined && attempt.intent.resourceDigests[id] !== digest) artifactReject('artifact-resource-binding-mismatch')
  }
  const effect = stage.effects?.find(item => item.effectId === reservation.effectId)
  if (
    effect?.state !== 'succeeded' ||
    effect.kind !== 'spawn' ||
    effect.resultMemberId !== member.sessionId ||
    effect.memberName !== reservation.nativeName ||
    effect.actorSessionId !== stage.leadSessionId
  )
    artifactReject('artifact-spawn-unverified')
  if (requireCurrentEvidence && !isDeepStrictEqual(member.evidence, memberEvidenceForArtifact(ref))) artifactReject('artifact-current-capture-mismatch')
  const { evidenceDigest, ...facts } = ref
  if (evidenceDigest !== captureEvidenceDigest(facts)) artifactReject('artifact-provenance-digest-mismatch')
}

export function fullArtifactPolicy(record: RunRecord): { stage: TeamStageRecord; requiredIds: string[]; primaryId: string } {
  const { node, stage } = frozenArtifactNode(record)
  const declared = node.teamStage!.members
  const reservations = stage.reservations ?? []
  if (reservations.length !== declared.length) artifactReject('artifact-required-reservation-missing')
  const ordered = declared.map(member => reservations.find(item => item.logicalName === member.name))
  if (ordered.some(item => item?.memberId === undefined || item.sessionId === undefined)) artifactReject('artifact-required-member-missing')
  const requiredIds = ordered.map(item => item!.memberId!)
  if (
    ordered.some(
      item =>
        item!.schemaDigest !== ordered[0]!.schemaDigest ||
        item!.schemaCanonicalJson !== ordered[0]!.schemaCanonicalJson ||
        item!.schemaResourceDigest !== ordered[0]!.schemaResourceDigest
    )
  )
    artifactReject('artifact-schema-binding-mismatch')
  if (
    new Set(requiredIds).size !== declared.length ||
    new Set(ordered.map(item => item!.sessionId)).size !== declared.length ||
    !isDeepStrictEqual(stage.requiredMemberIds, requiredIds) ||
    stage.primaryMemberId !== requiredIds[0]
  )
    artifactReject('artifact-required-policy-mismatch')
  if (
    node.teamStage!.requiredChecks.some(check => !TEAM_KNOWN_CHECKS.includes(check as (typeof TEAM_KNOWN_CHECKS)[number])) ||
    !isDeepStrictEqual(stage.requiredChecks, node.teamStage!.requiredChecks)
  )
    artifactReject('artifact-required-check-mismatch')
  if (stage.effects?.some(effect => ['pending', 'recovery_required'].includes(effect.state))) artifactReject('artifact-pending-effect')
  return { stage, requiredIds, primaryId: requiredIds[0]! }
}
